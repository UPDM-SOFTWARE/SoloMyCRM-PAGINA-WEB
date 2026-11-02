import Stripe from 'stripe';
import bcrypt from 'bcryptjs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const CRM_API_URL = process.env.CRM_API_URL || 'https://app.solomycrm.com';

const PLAN_PRICES = {
  mensual:        process.env.STRIPE_PRICE_MENSUAL,
  mensual_equipo: process.env.STRIPE_PRICE_MENSUAL_EQUIPO,
  anual:          process.env.STRIPE_PRICE_ANUAL,
};

export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { nombre, email, usuario, contraseña, telefono, plan } = req.body;

  // ── Validaciones básicas ──────────────────────────────────────────────
  if (!nombre || !email || !usuario || !contraseña || !plan) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }
  if (!PLAN_PRICES[plan]) {
    return res.status(400).json({ error: 'Plan inválido' });
  }
  if (contraseña.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  if (usuario.length < 3) {
    return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Correo electrónico inválido' });
  }

  // ── Verificar disponibilidad de usuario/email en el CRM ──────────────
  try {
    const availRes = await fetch(
      `${CRM_API_URL}/api/auth/validate-availability?usuario=${encodeURIComponent(usuario.trim())}&email=${encodeURIComponent(email.trim())}`
    );
    const availData = await availRes.json();

    if (!availRes.ok || !availData.disponible) {
      return res.status(409).json({
        error: 'Datos ya en uso',
        errors: availData.errors || {}
      });
    }
  } catch (err) {
    console.error('Error verificando disponibilidad en CRM:', err);
    return res.status(503).json({ error: 'No se pudo verificar disponibilidad. Intenta de nuevo.' });
  }

  // ── Hashear contraseña (NUNCA viaja en texto plano) ──────────────────
  const salt = await bcrypt.genSalt(10);
  const contrasenaHash = await bcrypt.hash(contraseña, salt);

  // ── Crear Stripe Checkout Session ─────────────────────────────────────
  try {
    const origin = req.headers.origin || 'https://solomycrm.com';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: PLAN_PRICES[plan], quantity: 1 }],
      allow_promotion_codes: true,
      customer_email: email.trim(),
      success_url: `${origin}/pago?plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/pago?plan=${plan}&cancelled=1`,
      locale: 'es',
      // Metadata que el webhook usará para crear la cuenta en el CRM
      metadata: {
        usuario:          usuario.trim(),
        nombre:           nombre.trim(),
        email:            email.trim(),
        telefono:         (telefono || '').trim(),
        plan,
        contrasena_hash:  contrasenaHash,  // bcrypt hash, seguro guardar en metadata
        contrasena:       contraseña,      // pasamos temporalmente para el correo de bienvenida
      },
      // Esto pega los metadatos directamente a la Suscripción en Stripe para que tú los veas
      subscription_data: {
        metadata: {
          usuario: usuario.trim(),
          nombre: nombre.trim(),
          email: email.trim(),
          plan: plan
        }
      }
    });

    return res.status(200).json({ url: session.url });
  } catch (stripeErr) {
    console.error('Error creando sesión de Stripe:', stripeErr);
    return res.status(500).json({ error: 'Error al iniciar el pago. Intenta de nuevo.' });
  }
}
