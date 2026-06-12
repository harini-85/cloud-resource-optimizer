/**
 * Master Script: Fetch ALL Missing Pricing Data
 * 
 * This script orchestrates the complete data collection process
 * to achieve 100% pricing coverage for all clouds.
 * 
 * Estimated Time: 4-6 hours
 * Estimated Records: ~695,000 new records
 */

const { Pool } = require('pg');
const path = require('path');

// Clear any existing AWS environment variables
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;

// Load from .env file
require('dotenv').config({ path: path.join(__dirname, '../.env') });

console.log('Loaded AWS credentials:', {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretKeyPrefix: process.env.AWS_SECRET_ACCESS_KEY?.substring(0, 20)
});

const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || 5432,
    database: process.env.POSTGRES_DB || 'cloud_optimizer',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'root'
});

// Import individual fetchers
const fetchAWSData = require('./fetchers/fetch_aws_complete');
const fetchAzureData = require('./fetchers/fetch_azure_complete');
const fetchGCPData = require('./fetchers/fetch_gcp_complete');

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  COMPLETE PRICING DATA COLLECTION');
    console.log('  Target: 100% Coverage for AWS, Azure, and GCP');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const startTime = Date.now();

    try {
        // Phase 1: AWS Data Collection
        console.log('\n📊 PHASE 1: AWS DATA COLLECTION');
        console.log('─'.repeat(70));
        await fetchAWSData(pool);

        // Phase 2: Azure Data Collection
        console.log('\n\n📊 PHASE 2: AZURE DATA COLLECTION');
        console.log('─'.repeat(70));
        await fetchAzureData(pool);

        // Phase 3: GCP Data Collection
        console.log('\n\n📊 PHASE 3: GCP DATA COLLECTION');
        console.log('─'.repeat(70));
        await fetchGCPData(pool);

        // Phase 4: Verification
        console.log('\n\n📊 PHASE 4: VERIFICATION');
        console.log('─'.repeat(70));
        await verifyCompleteness(pool);

        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000 / 60).toFixed(2);

        console.log('\n\n✅ DATA COLLECTION COMPLETE!');
        console.log(`Total Time: ${duration} minutes`);
        console.log('═'.repeat(70));

    } catch (error) {
        console.error('\n❌ ERROR:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

async function verifyCompleteness(pool) {
    console.log('\nVerifying data completeness...\n');

    const tables = [
        'aws_spot_pricing',
        'aws_reserved_pricing',
        'aws_savings_plans',
        'azure_reserved_pricing',
        'azure_hybrid_benefit',
        'gcp_preemptible_pricing',
        'gcp_committed_pricing',
        'gcp_os_pricing'
    ];

    for (const table of tables) {
        const result = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
        console.log(`  ${table.padEnd(30)} ${result.rows[0].count.toLocaleString()} records`);
    }

    // Update metadata
    for (const table of tables) {
        const result = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
        const cloud = table.startsWith('aws') ? 'AWS' : table.startsWith('azure') ? 'Azure' : 'GCP';

        await pool.query(`
            UPDATE pricing_metadata 
            SET record_count = $1, 
                last_updated = NOW(),
                data_source = 'API'
            WHERE cloud_provider = $2 AND table_name = $3
        `, [result.rows[0].count, cloud, table]);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = main;
