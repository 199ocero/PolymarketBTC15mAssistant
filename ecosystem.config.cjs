module.exports = {
  apps: [{
    name: "polybot",
    script: "./src/index.js",
    instances: 1,
    autorestart: true,
    watch: false,
    exec_mode: "fork",
    max_memory_restart: "1G",
    env: {
      NODE_ENV: "production",
    },
    node_args: "-r dotenv/config --expose-gc --max-old-space-size=4096",
    out_file: "./logs/pm2_out.log",
    error_file: "./logs/pm2_error.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs: true
  }]
}
