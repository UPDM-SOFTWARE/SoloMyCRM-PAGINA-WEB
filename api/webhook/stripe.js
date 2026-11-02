import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const CRM_API_URL = process.env.CRM_API_URL || "https://app.solomycrm.com";
const WEBHOOK_INTERNAL_SECRET = process.env.WEBHOOK_INTERNAL_SECRET;

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Helper: llama al CRM con el secret interno
async function callCRM(path, body) {
  const res = await fetch(`${CRM_API_URL}/api/auth${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": WEBHOOK_INTERNAL_SECRET,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ── Handlers por evento ────────────────────────────────────────────────────

async function handleCheckoutCompleted(session) {
  if (session.payment_status !== "paid") {
    console.log("⚠️ Checkout completado pero no pagado, ignorando.");
    return;
  }

  const { usuario, nombre, email, telefono, plan, contrasena_hash, contrasena, is_renewal } = session.metadata || {};

  if (is_renewal === "true") {
    console.log(`💳 Renovación confirmada para: ${usuario} (plan: ${plan})`);
    const { ok, data } = await callCRM("/register-paid", {
      usuario,
      email,
      plan,
      stripe_customer_id: session.customer || null,
      stripe_subscription_id: session.subscription || null,
      is_renewal: true
    });
    if (!ok) {
      console.error("❌ Error renovando en CRM:", data);
    } else {
      console.log("✅ Renovación exitosa en CRM");
    }
    return;
  }

  if (!usuario || !nombre || !email || !plan || !contrasena_hash) {
    console.error("❌ Metadata incompleta en sesion:", session.id, session.metadata);
    return;
  }

  console.log(`💳 Pago confirmado para: ${usuario} (plan: ${plan}) — creando cuenta en CRM...`);

  const { ok, data } = await callCRM("/register-paid", {
    usuario,
    contraseña_hash: contrasena_hash,
    contraseña_plana: contrasena, // Se pasa para enviar el correo de bienvenida con la pass original
    nombre,
    email,
    telefono: telefono || "",
    plan,
    stripe_customer_id: session.customer || null,
    stripe_subscription_id: session.subscription || null,
  });

  if (!ok) {
    if (data.code === "USUARIO_DUPLICADO" || data.code === "EMAIL_DUPLICADO") {
      console.warn(`⚠️ Cuenta ya existía para ${usuario}`);
    } else {
      console.error(`❌ Error creando cuenta en CRM para ${usuario}:`, data);
    }
  } else {
    console.log(`✅ Cuenta creada en CRM para: ${usuario}`);
  }
}

async function handleSubscriptionDeleted(subscription) {
  console.log(`🗑️ Suscripción cancelada: ${subscription.id} — suspendiendo cuenta en CRM...`);

  const { ok, data } = await callCRM("/suspend-subscription", {
    stripe_subscription_id: subscription.id,
    stripe_customer_id: subscription.customer || null,
    action: "suspend",
  });

  if (!ok) {
    console.error("❌ Error suspendiendo cuenta en CRM:", data);
  } else {
    console.log(`✅ Cuenta suspendida en CRM: ${data.usuario}`);
  }
}

async function handleSubscriptionPaused(subscription) {
  console.log(`⏸️ Suscripción pausada: ${subscription.id} — suspendiendo cuenta en CRM...`);

  const { ok, data } = await callCRM("/suspend-subscription", {
    stripe_subscription_id: subscription.id,
    stripe_customer_id: subscription.customer || null,
    action: "suspend",
  });

  if (!ok) {
    console.error("❌ Error suspendiendo cuenta (pausa) en CRM:", data);
  } else {
    console.log(`✅ Cuenta suspendida por pausa en CRM: ${data.usuario}`);
  }
}

async function handleSubscriptionUpdated(subscription, previousAttributes = {}) {
  const status = subscription.status;
  console.log(`🔄 Suscripción actualizada: ${subscription.id} — status: ${status}`);

  // Calcular nueva fecha de vencimiento desde los periodos de Stripe
  let plan_vencimiento = null;
  if (subscription.current_period_end) {
    plan_vencimiento = new Date(subscription.current_period_end * 1000).toISOString();
  }

  // Intentar determinar el nuevo plan según el precio (si cambió)
  // Los price IDs se pueden comparar con las env vars para mapear al plan interno
  let plan = null;
  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (priceId) {
    const priceMap = {
      [process.env.STRIPE_PRICE_MENSUAL]:        "mensual",
      [process.env.STRIPE_PRICE_MENSUAL_EQUIPO]: "mensual_equipo",
      [process.env.STRIPE_PRICE_ANUAL]:          "anual",
    };
    plan = priceMap[priceId] || null;
  }

  // Comprobar si hubo un cambio en current_period_end (indicador de renovación de ciclo)
  const is_renewal = previousAttributes?.current_period_end && subscription.current_period_end > previousAttributes.current_period_end ? true : false;

  const { ok, data } = await callCRM("/update-subscription", {
    stripe_subscription_id: subscription.id,
    stripe_customer_id: subscription.customer || null,
    status,
    plan,
    plan_vencimiento,
    is_renewal
  });

  if (!ok) {
    console.error("❌ Error actualizando suscripción en CRM:", data);
  } else {
    console.log(`✅ Suscripción actualizada en CRM: ${data.usuario} — status: ${status}`);
  }
}

async function handleInvoicePaymentFailed(invoice) {
  console.warn(`💸 Pago fallido — invoice: ${invoice.id}, customer: ${invoice.customer}, intento #${invoice.attempt_count}`);

  // Iniciar periodo de gracia de 3 días en el CRM para que el usuario pueda actualizar su método de pago
  // (Stripe seguirá reintentando el cobro automáticamente según tu config de reintentos)
  if (invoice.subscription) {
    const { ok, data } = await callCRM("/suspend-subscription", {
      stripe_subscription_id: invoice.subscription,
      stripe_customer_id: invoice.customer || null,
      action: "suspend", // Inicia gracia — el usuario sigue con acceso 3 días más
    });

    if (!ok) {
      console.error("❌ Error iniciando periodo de gracia tras pago fallido:", data);
    } else {
      console.log(`✅ Periodo de gracia iniciado por pago fallido para: ${data.usuario}`);
    }
  }
}

async function handleInvoicePaid(invoice) {
  // Solo procesar si es un cobro recurrente de una suscripción
  if (invoice.subscription && invoice.billing_reason === 'subscription_cycle') {
    console.log(`✅ Pago mensual/anual recurrente procesado exitosamente: ${invoice.id}, customer: ${invoice.customer}`);
    
    const { ok, data } = await callCRM("/renew-subscription", {
      stripe_subscription_id: invoice.subscription,
      stripe_customer_id: invoice.customer || null
    });

    if (!ok) {
      console.error("❌ Error notificando renovación en CRM:", data);
    } else {
      console.log(`✅ Notificación de renovación enviada por correo a: ${data.usuario}`);
    }
  }
}


// ── Handler principal ──────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo no permitido" });
  }

  const sig = req.headers["stripe-signature"];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Firma de webhook invalida:", err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  console.log(`📨 Evento recibido de Stripe: ${event.type}`);

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object);
        break;

      case "customer.subscription.paused":
        await handleSubscriptionPaused(event.data.object);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object, event.data.previous_attributes);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object);
        break;

      case "invoice.paid":
        await handleInvoicePaid(event.data.object);
        break;

      default:
        console.log(`ℹ️ Evento no manejado: ${event.type}`);
    }
  } catch (handlerErr) {
    // No retornamos 500 a Stripe (si no, reintentaría el evento indefinidamente).
    // Logueamos el error y retornamos 200 para que Stripe no reintente.
    console.error(`❌ Error procesando evento ${event.type}:`, handlerErr.message);
  }

  return res.status(200).json({ received: true });
}
