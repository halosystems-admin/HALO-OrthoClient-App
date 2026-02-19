import dotenv from 'dotenv';

dotenv.config();

// --- Required Environment Variables ---
const REQUIRED_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GEMINI_API_KEY', 'SESSION_SECRET'] as const;

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in the values.');
  process.exit(1);
}

// --- Validated Config Export ---
export const config = {
  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID!,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET!,

  // AI
  geminiApiKey: process.env.GEMINI_API_KEY!,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',

  // Session
  sessionSecret: process.env.SESSION_SECRET!,

  // Server
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // URLs
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  productionUrl: process.env.PRODUCTION_URL || '',

  // Drive API
  driveApi: 'https://www.googleapis.com/drive/v3',
  uploadApi: 'https://www.googleapis.com/upload/drive/v3',

  // Halo Functions API
  haloApiBaseUrl: process.env.HALO_API_BASE_URL || 'https://halo-functions-75316778879.africa-south1.run.app',
  haloUserId: process.env.HALO_USER_ID || 'cae6877e-0fbe-4ea1-acce-39957e7575bc',

  // Template request email (optional)
  adminEmail: process.env.ADMIN_EMAIL || 'admin@halo.africa',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
} as const;
