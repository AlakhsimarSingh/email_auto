try { process.loadEnvFile(); } catch {}
export const env = process.env as Record<string, string>;
