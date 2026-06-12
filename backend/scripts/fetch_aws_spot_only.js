/**
 * AWS Spot Pricing Fetcher (Simplified with Delays)
 * 
 * Fetches spot pricing for all AWS regions with delays to avoid rate limiting
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Clear any existing AWS env vars
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_REGION;

// Reload .env
require('dotenv').config({ path: path.join(__dirname, '../.env'), override: true });

const { EC2Client, DescribeSpotPriceHistoryCommand } = require('@aws-sdk/client-ec2');
const { Pool } = require('pg');

// Helper function for delays
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// AWS Regions
const AWS_REGIONS = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'ca-central-1',
    'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
    'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
    'ap-south-1', 'ap-southeast-1', 'ap-southeast-2',
    'sa-east-1',
    'us-west-3', 'af-south-1', 'ap-east-1', 'ap-south-2',
    'ap-southeast-3', 'ap-southeast-4', 'eu-south-1', 'eu-south-2',
    'eu-central-2', 'il-central-1', 'me-south-1', 'me-central-1'
];

async function fetchSpotPricing() {
    console.log('='.repeat(80));
    console.log('AWS SPOT PRICING DATA FETCH');
    console.log('='.repeat(80));
    console.log('');
    console.log(`AWS Access Key: ${process.env.AWS_ACCESS_KEY_ID?.substring(0, 15)}...`);
    console.log(`Total regions to process: ${AWS_REGIONS.length}`);
    console.log('');

    // Database connection
    const pool = new Pool({
        host: process.env.POSTGRES_HOST,
        port: process.env.POSTGRES_PORT,
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
    });

    let totalRecords = 0;
    let successfulRegions = 0;
    let failedRegions = 0;

    console.log('Fetching spot pricing for all regions...');
    console.log('');

    for (const region of AWS_REGIONS) {
        console.log(`Processing ${region}...`);

        try {
            // Create EC2 client for this region with explicit credentials
            const ec2Client = new EC2Client({
                region: region,
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                },
                maxAttempts: 3,
                requestHandler: {
                    connectionTimeout: 10000,
                    socketTimeout: 10000
                }
            });

            // Fetch spot price history
            const command = new DescribeSpotPriceHistoryCommand({
                StartTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
                ProductDescriptions: ['Linux/UNIX'],
                MaxResults: 1000
            });

            const response = await ec2Client.send(command);
            const spotPrices = response.SpotPriceHistory || [];

            console.log(`  Found ${spotPrices.length} spot prices`);

            // Insert into database
            let regionRecords = 0;
            for (const spot of spotPrices) {
                try {
                    await pool.query(`
            INSERT INTO aws_spot_pricing (
              region, instance_type, os, availability_zone, spot_price, 
              last_updated
            ) VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (region, instance_type, os, availability_zone) 
            DO UPDATE SET 
              spot_price = EXCLUDED.spot_price,
              last_updated = NOW()
          `, [
                        region,
                        spot.InstanceType,
                        spot.ProductDescription || 'Linux/UNIX',
                        spot.AvailabilityZone,
                        parseFloat(spot.SpotPrice)
                    ]);
                    regionRecords++;
                } catch (dbError) {
                    // Skip individual record errors
                }
            }

            console.log(`✅ ${region}: ${regionRecords} spot prices saved to database`);
            totalRecords += regionRecords;
            successfulRegions++;

            // Add delay between regions to avoid rate limiting
            await delay(2000); // 2 second delay

        } catch (error) {
            console.error(`❌ ${region}: ${error.message}`);
            failedRegions++;

            // Add longer delay after error
            await delay(5000); // 5 second delay after error
        }
    }

    await pool.end();

    console.log('');
    console.log('='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total regions processed: ${AWS_REGIONS.length}`);
    console.log(`Successful: ${successfulRegions}`);
    console.log(`Failed: ${failedRegions}`);
    console.log(`Total spot pricing records added: ${totalRecords}`);
    console.log('');
}

fetchSpotPricing().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
