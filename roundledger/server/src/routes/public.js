import fs from 'node:fs';

export default function registerPublic(router, { db, settings, ai, version, config }) {
  router.add('GET', '/api/health', { auth: 'public', maintenanceExempt: true }, () => {
    let dbOk = true;
    try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    return { status: dbOk ? 'ok' : 'degraded', version, time: Date.now(), database: dbOk ? 'ok' : 'error' };
  });

  router.add('GET', '/api/public/config', { auth: 'public', maintenanceExempt: true }, () => {
    const trial = settings.get('trial');
    const maintenance = settings.get('maintenance');
    const plans = db.prepare(`SELECT id, code, name, description, price_cents, currency, duration_days, device_limit, features, is_featured
      FROM plans WHERE is_active = 1 ORDER BY display_order, id`).all().map((p) => ({
      id: p.id, code: p.code, name: p.name, description: p.description, priceCents: p.price_cents, currency: p.currency,
      durationDays: p.duration_days, deviceLimit: p.device_limit, features: JSON.parse(p.features), featured: !!p.is_featured,
    }));
    return {
      serverVersion: version,
      branding: settings.get('branding'),
      registrationEnabled: settings.get('registration').enabled,
      trial: { enabled: trial.enabled, durationDays: trial.durationDays },
      maintenance: { enabled: maintenance.enabled, message: maintenance.enabled ? maintenance.message : '' },
      platforms: settings.get('platforms'),
      extension: settings.get('extension'),
      ai: ai.publicStatus(),
      plans,
    };
  });
}

export function dbFileSize(config) {
  try { return fs.statSync(config.databasePath).size; } catch { return null; }
}
