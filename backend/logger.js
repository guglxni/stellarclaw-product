'use strict';

const isProd = process.env.NODE_ENV === 'production';
const LOG_LEVEL = (process.env.LOG_LEVEL || (isProd ? 'info' : 'debug')).toLowerCase();

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = LEVELS[LOG_LEVEL] ?? LEVELS.info;

function formatJson(level, tag, msg, extra) {
    const entry = {
        ts: new Date().toISOString(),
        level,
        tag,
        msg: typeof msg === 'string' ? msg : JSON.stringify(msg),
    };
    if (extra && Object.keys(extra).length > 0) entry.ctx = extra;
    return JSON.stringify(entry);
}

function formatHuman(level, tag, msg, extra) {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = `${ts} [${level.toUpperCase().padEnd(5)}] [${tag}]`;
    const extraStr = extra && Object.keys(extra).length > 0
        ? ' ' + JSON.stringify(extra)
        : '';
    return `${prefix} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}${extraStr}`;
}

const format = isProd ? formatJson : formatHuman;

function emit(level, tag, msg, extra) {
    if (LEVELS[level] < threshold) return;
    const line = format(level, tag, msg, extra);
    if (level === 'error') {
        process.stderr.write(line + '\n');
    } else {
        process.stdout.write(line + '\n');
    }
}

/**
 * Create a tagged logger instance.
 * Usage:
 *   const log = require('./logger')('webhook');
 *   log.info('Event received', { type: 'payment.succeeded' });
 */
function createLogger(tag) {
    return {
        debug: (msg, extra) => emit('debug', tag, msg, extra),
        info:  (msg, extra) => emit('info',  tag, msg, extra),
        warn:  (msg, extra) => emit('warn',  tag, msg, extra),
        error: (msg, extra) => emit('error', tag, msg, extra),
        /** Create a child logger with a sub-tag */
        child: (subtag) => createLogger(`${tag}:${subtag}`),
    };
}

module.exports = createLogger;
