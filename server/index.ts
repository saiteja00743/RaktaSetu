import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import twilio from 'twilio';

const app = express();
const port = Number(process.env.PORT || 4000);
const prisma = new PrismaClient();

// ─── Twilio WhatsApp client ──────────────────────────────────────────────────
const USE_WHATSAPP = process.env.WHATSAPP_PROVIDER === 'twilio'
  && !!process.env.TWILIO_ACCOUNT_SID
  && !!process.env.TWILIO_AUTH_TOKEN;

const twilioClient = USE_WHATSAPP
  ? twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!)
  : null;

const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

/**
 * Send a WhatsApp message via Twilio.
 * Phone must be in E.164 format e.g. +919876543210
 */
async function sendWhatsApp(to: string, body: string): Promise<boolean> {
  if (!twilioClient) {
    console.log(`[WhatsApp MOCK] To: ${to}\n${body}`);
    return true;
  }
  try {
    // Ensure the number has the whatsapp: prefix
    const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    await twilioClient.messages.create({ from: WHATSAPP_FROM, to: toFormatted, body });
    console.log(`[WhatsApp ✅] Sent to ${to}`);
    return true;
  } catch (err: any) {
    console.error(`[WhatsApp ❌] Failed to send to ${to}:`, err?.message || err);
    return false;
  }
}

/**
 * Find donors with matching blood group who have consented to notifications,
 * then send each a WhatsApp alert about the new blood request.
 */
async function notifyMatchingDonors(request: {
  id: string;
  bloodGroup: string;
  component: string;
  units: number;
  urgency: string;
  city: string;
  hospital: string;
}): Promise<{ notified: number; failed: number }> {
  // Blood compatibility map — who can donate to whom
  const compatibleDonors: Record<string, string[]> = {
    'O+':  ['O+', 'O−'],
    'O−':  ['O−'],
    'A+':  ['A+', 'A−', 'O+', 'O−'],
    'A−':  ['A−', 'O−'],
    'B+':  ['B+', 'B−', 'O+', 'O−'],
    'B−':  ['B−', 'O−'],
    'AB+': ['AB+', 'AB−', 'A+', 'A−', 'B+', 'B−', 'O+', 'O−'],
    'AB−': ['AB−', 'A−', 'B−', 'O−'],
  };

  const compatibleGroups = compatibleDonors[request.bloodGroup] ?? [request.bloodGroup];

  // Fetch matching available donors with notification consent and a phone number
  const donors = await prisma.donorProfile.findMany({
    where: {
      bloodGroup: { in: compatibleGroups },
      availability: 'AVAILABLE',
      notificationConsent: true,
    },
    include: { user: { select: { name: true, phone: true } } },
    take: 50, // cap at 50 to avoid spam
  });

  if (donors.length === 0) {
    console.log('[WhatsApp] No matching donors found to notify.');
    return { notified: 0, failed: 0 };
  }

  const urgencyEmoji: Record<string, string> = {
    'Immediately': '🚨',
    'IMMEDIATE': '🚨',
    'Within 24 hours': '⚠️',
    'WITHIN_24_HOURS': '⚠️',
    'Within 3 days': '📌',
    'WITHIN_3_DAYS': '📌',
  };

  const emoji = urgencyEmoji[request.urgency] ?? '🩸';

  const message = `${emoji} *RaktaSetu Blood Request Alert*

A patient near *${request.city}* needs your help!

🩸 *Blood Group:* ${request.bloodGroup}
💉 *Component:* ${request.component}
📦 *Units Needed:* ${request.units}
🏥 *Hospital:* ${request.hospital}
⏰ *Urgency:* ${request.urgency}
🆔 *Request ID:* ${request.id}

If you're available to donate, please contact the hospital directly or reply to coordinate.

_This message was sent by RaktaSetu because you registered as a donor with notification consent. Reply STOP to opt out._`;

  let notified = 0;
  let failed = 0;

  for (const donor of donors) {
    const phone = donor.user.phone;
    if (!phone) continue;

    const success = await sendWhatsApp(phone, message);
    if (success) notified++;
    else failed++;

    // Small delay to avoid Twilio rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[WhatsApp] Notified ${notified} donors, ${failed} failed.`);
  return { notified, failed };
}

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '24kb' }));

// ─── In-memory store for blood requests (session) ───────────────────────────
type RequestRecord = {
  id: string; bloodGroup: string; component: string; units: number;
  urgency: string; city: string; hospital: string; patient: string;
  status: string; createdAt: string; consent: boolean;
  notifiedDonors?: number;
};
const requests = new Map<string, RequestRecord>();
const events   = new Map<string, { at: string; label: string }[]>();

const createSchema = z.object({
  id:          z.string().regex(/^RK-[A-Z0-9]{6}$/),
  bloodGroup:  z.string().min(1).max(16),
  component:   z.string().min(1).max(60),
  units:       z.number().int().min(1).max(20),
  urgency:     z.string().min(1).max(60),
  city:        z.string().min(1).max(100),
  hospital:    z.string().max(160),
  patient:     z.string().max(80),
  phone:       z.string().max(24).optional(),
  status:      z.literal('Open'),
  createdAt:   z.string().datetime(),
  consent:     z.literal(true),
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  mode: 'live',
  database: 'supabase',
  whatsapp: USE_WHATSAPP ? 'twilio' : 'mock',
}));

// ─── Blood Banks ─────────────────────────────────────────────────────────────
app.get('/api/banks', (_req, res) => res.json({
  items: [], simulated: false,
  note: 'Connect a verified facility data source to populate this endpoint.',
}));

// ─── Blood Requests ──────────────────────────────────────────────────────────
app.get('/api/requests', (_req, res) => res.json([...requests.values()]));

app.post('/api/requests', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request details or sharing consent are missing.' } });
  if (requests.has(parsed.data.id))
    return res.status(409).json({ error: { code: 'DUPLICATE_REQUEST', message: 'This tracking ID already exists.' } });

  requests.set(parsed.data.id, { ...parsed.data });
  events.set(parsed.data.id, [{ at: new Date().toISOString(), label: 'Request submitted' }]);

  // Respond immediately — don't block on WhatsApp
  res.status(201).json(parsed.data);

  // Fire WhatsApp notifications in background
  try {
    const { notified, failed } = await notifyMatchingDonors({
      id:         parsed.data.id,
      bloodGroup: parsed.data.bloodGroup,
      component:  parsed.data.component,
      units:      parsed.data.units,
      urgency:    parsed.data.urgency,
      city:       parsed.data.city,
      hospital:   parsed.data.hospital,
    });

    // Update request with notification count
    const r = requests.get(parsed.data.id);
    if (r) r.notifiedDonors = notified;

    events.get(parsed.data.id)?.push({
      at: new Date().toISOString(),
      label: notified > 0
        ? `WhatsApp sent to ${notified} matching donor${notified > 1 ? 's' : ''}`
        : 'No matching donors to notify',
    });

    console.log(`[Request ${parsed.data.id}] Notifications: ${notified} sent, ${failed} failed`);
  } catch (err) {
    console.error('[WhatsApp notify error]', err);
  }
});

app.get('/api/requests/:id', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  res.json(r);
});

app.get('/api/requests/:id/timeline', (req, res) => {
  if (!requests.has(req.params.id))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  res.json(events.get(req.params.id) || []);
});

app.get('/api/requests/:id/matches', (req, res) => {
  if (!requests.has(req.params.id))
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  res.json({ items: [], note: 'Donors are notified via WhatsApp.' });
});

app.post('/api/requests/:id/cancel', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  if (r.status === 'Fulfilled')
    return res.status(409).json({ error: { code: 'INVALID_STATUS', message: 'A fulfilled request cannot be cancelled here.' } });
  r.status = 'Cancelled';
  events.get(r.id)?.push({ at: new Date().toISOString(), label: 'Request cancelled' });
  res.json(r);
});

app.post('/api/matches/:id/respond', (req, res) => {
  const parsed = z.object({ response: z.enum(['ACCEPT', 'DECLINE', 'UNAVAILABLE']) }).safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Choose accept, decline or unavailable.' } });
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Request not found.' } });
  if (parsed.data.response === 'ACCEPT') r.status = 'Responses Received';
  events.get(r.id)?.push({ at: new Date().toISOString(), label: `Donor response: ${parsed.data.response.toLowerCase()}` });
  res.json({ recorded: true, response: parsed.data.response });
});

// ─── Donors — Real Supabase DB ───────────────────────────────────────────────
app.get('/api/donors', async (_req, res) => {
  try {
    const donors = await prisma.donorProfile.findMany({
      include: { user: { select: { name: true, createdAt: true } } },
      orderBy: { user: { createdAt: 'desc' } },
    });
    res.json(donors.map(d => ({
      id:                  d.userId,
      name:                d.user.name,
      bloodGroup:          d.bloodGroup,
      availability:        d.availability,
      verification:        d.verification,
      notificationConsent: d.notificationConsent,
      joinedAt:            d.user.createdAt,
    })));
  } catch (err) {
    console.error('GET /api/donors error:', err);
    res.status(500).json({ error: { code: 'DB_ERROR', message: 'Could not fetch donors.' } });
  }
});

app.post('/api/donors/profile', async (req, res) => {
  const schema = z.object({
    name:                z.string().min(1).max(80),
    phone:               z.string().min(6).max(24),
    bloodGroup:          z.string().min(1).max(16),
    city:                z.string().min(1).max(100),
    notificationConsent: z.boolean(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Required donor fields are missing.' } });

  try {
    const existing = await prisma.user.findUnique({ where: { phone: parsed.data.phone } });
    if (existing)
      return res.status(409).json({ error: { code: 'DUPLICATE_PHONE', message: 'This phone number is already registered as a donor.' } });

    const user = await prisma.user.create({
      data: {
        name:  parsed.data.name,
        phone: parsed.data.phone,
        role:  'DONOR',
        donorProfile: {
          create: {
            bloodGroup:          parsed.data.bloodGroup,
            notificationConsent: parsed.data.notificationConsent,
            availability:        'AVAILABLE',
            verification:        'UNVERIFIED',
          },
        },
      },
      include: { donorProfile: true },
    });

    // Send a welcome WhatsApp if consent given
    if (parsed.data.notificationConsent) {
      const welcomeMsg = `👋 *Welcome to RaktaSetu!*

Hi ${parsed.data.name}, you're now registered as a *${parsed.data.bloodGroup}* donor in *${parsed.data.city}*.

✅ You'll receive WhatsApp alerts when someone nearby needs your blood group.
🏥 Always confirm eligibility with the hospital or blood bank before donating.

_Reply STOP anytime to opt out of notifications._`;

      sendWhatsApp(parsed.data.phone, welcomeMsg).catch(console.error);
    }

    res.status(201).json({
      id:               user.id,
      name:             user.name,
      bloodGroup:       user.donorProfile?.bloodGroup,
      verificationStatus: 'UNVERIFIED',
      message:          'Donor profile saved successfully!',
    });
  } catch (err) {
    console.error('POST /api/donors/profile error:', err);
    res.status(500).json({ error: { code: 'DB_ERROR', message: 'Could not save donor profile.' } });
  }
});

// ─── Admin ───────────────────────────────────────────────────────────────────
app.get('/api/admin/verifications', async (_req, res) => {
  try {
    const donors = await prisma.donorProfile.findMany({
      where:   { verification: 'UNVERIFIED' },
      include: { user: { select: { name: true } } },
      take:    20,
    });
    res.json({ items: donors.map(d => ({ id: d.userId, name: d.user.name, type: 'Donor profile', status: 'UNVERIFIED' })) });
  } catch {
    res.json({ items: [], error: 'DB not available' });
  }
});

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }));

app.listen(port, () => {
  console.log(`🚀 RaktaSetu API on http://localhost:${port}`);
  console.log(`📱 WhatsApp: ${USE_WHATSAPP ? `Twilio (${WHATSAPP_FROM})` : 'Mock (log only)'}`);
});
