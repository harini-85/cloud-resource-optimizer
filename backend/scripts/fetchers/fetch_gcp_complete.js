/**
 * GCP Complete Pricing Data Fetcher
 * 
 * Fetches:
 * 1. Preemptible VM pricing
 * 2. Committed Use Discounts (1-year, 3-year)
 * 3. OS-specific pricing (RHEL, SLES, Windows)
 * 
 * Estimated Records: ~195,000
 * Estimated Time: 1-2 hours
 */

const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');

// Initialize Google Auth
const auth = new GoogleAuth({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});

// GCP Regions
const GCP_REGIONS = [
    'us-east1', 'us-east4', 'us-east5', 'us-west1', 'us-west2', 'us-west3', 'us-west4',
    'us-central1', 'us-south1',
    'northamerica-northeast1', 'northamerica-northeast2',
    'southamerica-east1', 'southamerica-west1',
    'europe-west1', 'europe-west2', 'europe-west3', 'europe-west4', 'europe-west6',
    'europe-west8', 'europe-west9', 'europe-west10', 'europe-west12',
    'europe-north1', 'europe-central2', 'europe-southwest1',
    'asia-east1', 'asia-east2', 'asia-northeast1', 'asia-northeast2', 'asia-northeast3',
    'asia-south1', 'asia-south2', 'asia-southeast1', 'asia-southeast2',
    'australia-southeast1', 'australia-southeast2',
    'me-central1', 'me-central2', 'me-west1',
    'africa-south1'
];

// Machine types
const MACHINE_FAMILIES = ['n1', 'n2', 'n2d', 'e2', 'c2', 'c2d', 'c3', 'm1', 'm2', 'm3', 't2d', 't2a'];

// Operating systems
const OPERATING_SYSTEMS = ['rhel', 'sles', 'windows'];

async function fetchGCPData(pool) {
    console.log('Starting GCP data collection...\n');

    // Step 1: Fetch preemptible pricing
    console.log('Step 1: Fetching preemptible VM pricing...');
    await fetchPreemptiblePricing(pool);

    // Step 2: Fetch committed use discounts
    console.log('\nStep 2: Fetching committed use discount pricing...');
    await fetchCommittedUsePricing(pool);

    // Step 3: Fetch OS-specific pricing
    console.log('\nStep 3: Fetching OS-specific pricing...');
    await fetchOSPricing(pool);

    console.log('\n✅ GCP data collection complete');
}

async function fetchPreemptiblePricing(pool) {
    console.log('  Fetching preemptible pricing for all regions...');

    let totalRecords = 0;

    // Get access token
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    for (const region of GCP_REGIONS) {
        console.log(`    Processing ${region}...`);

        try {
            // GCP Cloud Billing API
            const url = 'https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus';

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${accessToken.token}`
                }
            });

            let regionRecords = 0;

            for (const sku of response.data.skus || []) {
                // Filter for preemptible instances in this region
                if (sku.category?.resourceFamily === 'Compute' &&
                    sku.description?.toLowerCase().includes('preemptible') &&
                    sku.serviceRegions?.includes(region)) {

                    await insertPreemptiblePricing(pool, sku, region);
                    regionRecords++;
                }
            }

            totalRecords += regionRecords;
            console.log(`    ✅ ${region}: ${regionRecords} records`);

        } catch (error) {
            console.error(`    ❌ ${region}: ${error.message}`);
        }
    }

    console.log(`  Total: ${totalRecords} preemptible pricing records added`);
}

async function fetchCommittedUsePricing(pool) {
    console.log('  Fetching committed use discount pricing...');

    const terms = [1, 3]; // 1-year and 3-year
    let totalRecords = 0;

    // Get access token
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    for (const region of GCP_REGIONS) {
        console.log(`    Processing ${region}...`);

        for (const term of terms) {
            try {
                const url = 'https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus';

                const response = await axios.get(url, {
                    headers: {
                        'Authorization': `Bearer ${accessToken.token}`
                    }
                });

                let regionRecords = 0;

                for (const sku of response.data.skus || []) {
                    // Filter for committed use discounts
                    if (sku.category?.resourceFamily === 'Compute' &&
                        sku.description?.toLowerCase().includes('commitment') &&
                        sku.serviceRegions?.includes(region)) {

                        await insertCommittedUsePricing(pool, sku, region, term);
                        regionRecords++;
                    }
                }

                totalRecords += regionRecords;

            } catch (error) {
                console.error(`      ❌ ${region} ${term}yr: ${error.message}`);
            }
        }

        console.log(`    ✅ ${region} complete`);
    }

    console.log(`  Total: ${totalRecords} committed use pricing records added`);
}

async function fetchOSPricing(pool) {
    console.log('  Fetching OS-specific pricing...');

    let totalRecords = 0;

    // Get access token
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    for (const region of GCP_REGIONS) {
        console.log(`    Processing ${region}...`);

        for (const os of OPERATING_SYSTEMS) {
            try {
                const url = 'https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus';

                const response = await axios.get(url, {
                    headers: {
                        'Authorization': `Bearer ${accessToken.token}`
                    }
                });

                let regionRecords = 0;

                for (const sku of response.data.skus || []) {
                    // Filter for OS-specific pricing
                    const description = sku.description?.toLowerCase() || '';
                    if (sku.category?.resourceFamily === 'Compute' &&
                        (description.includes(os) || description.includes(os.toUpperCase())) &&
                        sku.serviceRegions?.includes(region)) {

                        await insertOSPricing(pool, sku, region, os);
                        regionRecords++;
                    }
                }

                totalRecords += regionRecords;

            } catch (error) {
                console.error(`      ❌ ${region} ${os}: ${error.message}`);
            }
        }

        console.log(`    ✅ ${region} complete`);
    }

    console.log(`  Total: ${totalRecords} OS-specific pricing records added`);
}

async function insertPreemptiblePricing(pool, sku, region) {
    try {
        const query = `
            INSERT INTO gcp_preemptible_pricing (
                region, machine_type, vcpu, memory_gb, preemptible_price, 
                currency, last_updated
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (region, machine_type) 
            DO UPDATE SET 
                preemptible_price = EXCLUDED.preemptible_price,
                last_updated = NOW()
        `;

        // Extract machine type from description
        const machineType = extractMachineType(sku.description);
        const pricing = sku.pricingInfo?.[0];
        const price = pricing?.pricingExpression?.tieredRates?.[0]?.unitPrice;

        if (!price || !machineType) return;

        const pricePerHour = (parseFloat(price.units || 0) + (parseFloat(price.nanos || 0) / 1e9));

        await pool.query(query, [
            region,
            machineType,
            0, // vCPU count - would need to be looked up
            0, // Memory - would need to be looked up
            pricePerHour,
            pricing?.currencyCode || 'USD'
        ]);
    } catch (error) {
        // Skip records with parsing errors
    }
}

async function insertCommittedUsePricing(pool, sku, region, term) {
    try {
        const query = `
            INSERT INTO gcp_committed_pricing (
                region, machine_type, term_years, discount_percent, 
                committed_price, currency, last_updated
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (region, machine_type, term_years) 
            DO UPDATE SET 
                discount_percent = EXCLUDED.discount_percent,
                committed_price = EXCLUDED.committed_price,
                last_updated = NOW()
        `;

        const machineType = extractMachineType(sku.description);
        const pricing = sku.pricingInfo?.[0];
        const price = pricing?.pricingExpression?.tieredRates?.[0]?.unitPrice;

        if (!price || !machineType) return;

        const pricePerHour = (parseFloat(price.units || 0) + (parseFloat(price.nanos || 0) / 1e9));

        // Committed use discounts: 1-year = 25%, 3-year = 52%
        const discountPercent = term === 1 ? 25 : 52;

        await pool.query(query, [
            region,
            machineType,
            term,
            discountPercent,
            pricePerHour,
            pricing?.currencyCode || 'USD'
        ]);
    } catch (error) {
        // Skip records with parsing errors
    }
}

async function insertOSPricing(pool, sku, region, os) {
    try {
        const query = `
            INSERT INTO gcp_os_pricing (
                region, machine_type, os, os_price_per_hour, 
                currency, last_updated
            ) VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (region, machine_type, os) 
            DO UPDATE SET 
                os_price_per_hour = EXCLUDED.os_price_per_hour,
                last_updated = NOW()
        `;

        const machineType = extractMachineType(sku.description);
        const pricing = sku.pricingInfo?.[0];
        const price = pricing?.pricingExpression?.tieredRates?.[0]?.unitPrice;

        if (!price || !machineType) return;

        const pricePerHour = (parseFloat(price.units || 0) + (parseFloat(price.nanos || 0) / 1e9));

        await pool.query(query, [
            region,
            machineType,
            os.toUpperCase(),
            pricePerHour,
            pricing?.currencyCode || 'USD'
        ]);
    } catch (error) {
        // Skip records with parsing errors
    }
}

function extractMachineType(description) {
    // Extract machine type from description
    // Example: "N1 Predefined Instance Core running in Americas"
    const match = description.match(/([a-z]\d+[a-z]?)-/i);
    return match ? match[1].toLowerCase() : null;
}

module.exports = fetchGCPData;
