import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import createSessionHandler from './api/checkout/create-session.js';
import stripeWebhookHandler from './api/webhook/stripe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Healthcheck para Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// 1. Webhook de Stripe (DEBE ir antes de express.json() para conservar el body crudo y validar firma)
app.all('/api/webhook/stripe', (req, res) => stripeWebhookHandler(req, res));

// 2. Parseo JSON para las demás rutas API
app.use(express.json());

// 3. Crear sesión de Stripe Checkout
app.all('/api/checkout/create-session', (req, res) => createSessionHandler(req, res));

// 4. Servir archivos estáticos compilados por Vite
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// 5. Fallback SPA para rutas del frontend (/pago, /precios, /funcionalidades, etc.)
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint no encontrado' });
  }
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SoloMyCRM-PAGINA-WEB servidor activo en 0.0.0.0:${PORT}`);
});

