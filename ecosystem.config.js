// PM2 Ecosystem Config — Arkheron Custom Game Bot
// Uso:
//   pm2 start ecosystem.config.js           (producao)
//   pm2 start ecosystem.config.js --env dev (debug/teste solo)
//   pm2 logs arkheron-bot                   (ver logs)
//   pm2 restart arkheron-bot                (reiniciar)

module.exports = {
  apps: [{
    name: 'arkheron-bot',
    script: 'index.js',
    cwd: __dirname,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    kill_timeout: 10000, // Espera graceful shutdown

    // Logs
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    merge_logs: true,

    // Producao
    env: {
      NODE_ENV: 'production',
      DEBUG_MODE: 'false',
    },

    // Dev/Teste solo (pm2 start --env dev)
    env_dev: {
      NODE_ENV: 'development',
      DEBUG_MODE: 'true',
      DEBUG_MIN_VOTES: '1',
      DEBUG_SKIP_ROLE_CHECK: 'true',
      VOTE_TIMEOUT_MS: '60000',   // 1 min (mais rapido para testes)
      CLOSE_DELAY_SEC: '3',
      LOG_LEVEL: 'debug',
    },
  }],
};
