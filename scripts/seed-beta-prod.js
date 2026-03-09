#!/usr/bin/env node
/**
 * seed-beta-prod.js — Seed beta codes into the production PostgreSQL database.
 *
 * These 100 codes already exist as 100% discount coupons in Dodo Payments.
 * This script only INSERT OR IGNOREs them into the `beta_codes` table.
 *
 * Usage (run on the droplet or locally with DATABASE_URL pointing to prod PG):
 *
 *   DATABASE_URL=postgres://... node scripts/seed-beta-prod.js
 *
 * Safe to re-run: uses ON CONFLICT DO NOTHING.
 */

'use strict';

const { Client } = require('pg');

const BETA_CODES = [
    'ZE6P-JAVD-T92N', 'NX0V-74SP-Y2KZ', 'NQFO-AAN5-Q09C', 'IOO9-H94W-S1IL', '8LO1-ZK0E-N7SX',
    'Z4XB-4IR5-77BY', '8PTJ-VGS7-O4SC', 'SRXC-PAUL-37FV', 'P417-ZS2M-3QF3', '5Q00-VOCI-FE9O',
    'DG1F-5EPI-Y6R2', '5N8B-UXGT-8DED', 'FEAH-M546-JJ53', 'QRW5-PU9S-34RY', 'WT3N-T6SD-A3N7',
    'LJ1K-9HJO-PF2Q', '1S2J-M5IL-8EJ7', 'DLFD-IVWE-X1HS', 'Q6HQ-I3VG-JLIF', 'B676-C6OX-BMSP',
    'WEEP-HHAN-H7M8', '9LD9-LMK5-2VXE', 'UUN6-ND87-0X68', '4K3O-PH7F-CVM7', 'CFO7-TVQP-KIV1',
    'U8R4-N3AL-747L', 'FD20-DU89-NDY7', '16L3-PQHA-MA70', 'SSWT-GMPV-AJ5J', 'C1LS-4P1D-TU27',
    'GG6B-NNO1-T7FL', '78CX-FZHP-WQHS', 'RG3B-737T-TIOC', 'E72H-MXQA-YCDC', '8WNZ-9069-4OS2',
    '1I0T-2NGZ-MW9K', 'T88V-D8JR-F0X1', '2XCD-QE8U-W63M', 'K9ZJ-RSP5-8CNH', 'CM1G-TACV-FF79',
    'DVP3-3JQT-IU55', '07IC-1A35-FVCF', '5TG0-44NT-1E28', 'USN6-WLID-B08U', '1A5D-VRLG-S9SL',
    'PT2F-GR1Y-S60Y', '4QHR-LNDY-FZVP', 'YRCB-X6W7-RQ6D', 'NGJZ-YIDH-4N3P', 'L34Z-WRS1-Q3YC',
    'TZRJ-9Y42-HBFA', 'ODON-0WFP-7SM0', 'X78R-413K-24SP', 'Q1NC-4C94-R98V', 'DBAH-GOFK-9U2Z',
    'UAW7-ZGFD-5S8D', '6NPC-JHUF-NHBV', 'LWND-C3WA-Y96V', '4GLF-SSWT-3PF1', 'C426-JCR3-B9ZT',
    'WDK5-CKEW-8QE8', '65HL-8BHN-J2NH', 'YTWE-WO68-5OFF', '960E-CWIW-Z9AF', 'RAWZ-FDNP-NTN0',
    'G2XK-4VYS-SPA6', 'T14J-5R86-Z28X', 'IYJF-XM09-40ZH', 'JL9U-XXPX-EJUS', 'PTZD-Q35J-8NXL',
    'OXL7-836V-1JYL', '8IXR-WCW5-HEY4', 'D5ZX-E4LR-LMFP', 'MIBB-H6QN-TNTK', 'CL4H-TXRO-BNK1',
    'OGF8-UIB2-V2WG', 'JFM6-VMO6-2O5N', 'XUTM-DEWZ-6ML6', 'YULU-EGMJ-6HXR', '3DZO-875X-XKJ9',
    'FQ92-T3B9-L1RN', 'SIDL-TSZQ-RBR3', 'MXBP-78PS-YRD5', 'Z6IB-ELNC-HAOG', 'G2JT-M1ZY-IBJ4',
    'TFF1-RT8C-Q4MN', 'IFQN-WQ0X-17G8', 'N83B-121S-P5ND', 'BM15-DWV2-7MRK', 'MWUO-JEIS-FN3H',
    'E8O9-J6OY-ASEJ', 'NO95-58MR-LU67', 'IAZ6-YIE6-IWCT', 'XOV1-WCOX-M0KZ', '1L6R-LUE2-SWAL',
    '2VDZ-ZJTO-E8EV', 'FMP2-11YV-WJPF', '960B-P19Q-846B', 'TZWC-5U8Q-USIH', '3BTR-SDS8-IRXS',
];

async function main() {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) {
        console.error('ERROR: DATABASE_URL environment variable is not set.');
        process.exit(1);
    }

    // Strip sslmode from the URL so pg-connection-string doesn't override the ssl config below.
    const url = rawUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
    const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    console.log('Connected to PostgreSQL.');

    // Ensure table exists (mirrors server.js schema)
    await client.query(`
        CREATE TABLE IF NOT EXISTS beta_codes (
            id           SERIAL PRIMARY KEY,
            code         TEXT NOT NULL UNIQUE,
            redeemed_by  TEXT UNIQUE,
            redeemed_at  TIMESTAMPTZ,
            redeemed_ip  TEXT,
            user_agent   TEXT,
            created_at   TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    let inserted = 0;
    for (const code of BETA_CODES) {
        const result = await client.query(
            'INSERT INTO beta_codes (code) VALUES ($1) ON CONFLICT (code) DO NOTHING',
            [code]
        );
        if (result.rowCount > 0) inserted++;
    }

    const { rows } = await client.query('SELECT COUNT(*) AS count FROM beta_codes');
    console.log(`Inserted: ${inserted} | Total in DB: ${rows[0].count}`);

    await client.end();
}

main().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
