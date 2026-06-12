/**
 * Azure and GCP Data Fetching Script
 * Fetches pricing data for Azure and GCP only (skipping AWS due to network issues)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Clear any existing AWS env vars that might conflict
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_REGION;

// Reload .env to get correct values
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });

const fetchAzureComplete = require('./fetchers/fetch_azure_complete');
const fetchGcpComplete = require('./fetchers/fetch_gcp_complete');

async function main() {
    console.log('='.repeat(80));
    console.log('AZURE AND GCP PRICING DATA FETCH');
    console.log('='.repeat(80));
    console.log('');
    console.log('This script will fetch:');
    console.log('  - Azure: Reserved pricing, Hybrid Benefit pricing');
    console.log('  - GCP: OS-specific pricing, Preemptible pricing');
    console.log('');
    console.log('AWS data fetching is skipped due to network issues.');
    console.log('You can retry AWS later when network issues are resolved.');
    console.log('');
    console.log('='.repeat(80));
    console.log('');

    try {
        // Phase 1: Azure Data Fetching
        console.log('\n' + '='.repeat(80));
        console.log('PHASE 1: AZURE DATA FETCHING');
        console.log('='.repeat(80));
        await fetchAzureComplete();

        // Phase 2: GCP Data Fetching
        console.log('\n' + '='.repeat(80));
        console.log('PHASE 2: GCP DATA FETCHING');
        console.log('='.repeat(80));
        await fetchGcpComplete();

        // Summary
        console.log('\n' + '='.repeat(80));
        console.log('DATA FETCH COMPLETE');
        console.log('='.repeat(80));
        console.log('');
        console.log('✅ Azure data fetching completed');
        console.log('✅ GCP data fetching completed');
        console.log('⚠️  AWS data fetching skipped (network issues)');
        console.log('');
        console.log('Next steps:');
        console.log('1. Run verification: node backend/scripts/verify_100_percent_coverage.js');
        console.log('2. Retry AWS data fetching when network issues are resolved');
        console.log('');

    } catch (error) {
        console.error('\n❌ Fatal error during data fetch:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the script
main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
});
