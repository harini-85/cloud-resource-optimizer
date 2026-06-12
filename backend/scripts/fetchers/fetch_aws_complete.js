/**
 * AWS Complete Pricing Data Fetcher
 * 
 * Fetches:
 * 1. Missing 16 AWS regions
 * 2. Spot pricing for all instance types
 * 3. Reserved Instance pricing (1-year, 3-year)
 * 4. Savings Plans
 * 
 * Estimated Records: ~350,000
 * Estimated Time: 2-3 hours
 */

const { PricingClient, GetProductsCommand } = require('@aws-sdk/client-pricing');
const { EC2Client, DescribeSpotPriceHistoryCommand } = require('@aws-sdk/client-ec2');

// AWS Credentials configuration
const awsConfig = {
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
};

// Missing AWS Regions
const MISSING_REGIONS = [
    'us-west-3',      // Las Vegas
    'af-south-1',     // Cape Town
    'ap-east-1',      // Hong Kong
    'ap-south-2',     // Hyderabad
    'ap-southeast-3', // Jakarta
    'ap-southeast-4', // Melbourne
    'eu-south-1',     // Milan
    'eu-south-2',     // Spain
    'eu-central-2',   // Zurich
    'il-central-1',   // Tel Aviv
    'me-south-1',     // Bahrain
    'me-central-1',   // UAE
];

// All AWS Regions (including existing + missing)
const ALL_REGIONS = [
    // Existing
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'ca-central-1',
    'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
    'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
    'ap-south-1', 'ap-southeast-1', 'ap-southeast-2',
    'sa-east-1',
    // Missing
    ...MISSING_REGIONS
];

async function fetchAWSData(pool) {
    console.log('Starting AWS data collection...\n');

    // Step 1: Fetch missing regions pricing
    console.log('Step 1: Fetching missing regions pricing...');
    await fetchMissingRegionsPricing(pool);

    // Step 2: Fetch spot pricing
    console.log('\nStep 2: Fetching spot pricing...');
    await fetchSpotPricing(pool);

    // Step 3: Fetch reserved pricing
    console.log('\nStep 3: Fetching reserved instance pricing...');
    await fetchReservedPricing(pool);

    // Step 4: Fetch savings plans
    console.log('\nStep 4: Fetching savings plans...');
    await fetchSavingsPlans(pool);

    console.log('\n✅ AWS data collection complete');
}

async function fetchMissingRegionsPricing(pool) {
    console.log(`  Fetching pricing for ${MISSING_REGIONS.length} missing regions...`);
    console.log(`  Using AWS credentials: ${awsConfig.credentials.accessKeyId?.substring(0, 15)}...`);

    const pricingClient = new PricingClient(awsConfig);

    let totalRecords = 0;

    for (const region of MISSING_REGIONS) {
        console.log(`    Processing ${region}...`);

        try {
            // Fetch EC2 pricing for this region
            const params = {
                ServiceCode: 'AmazonEC2',
                Filters: [
                    {
                        Type: 'TERM_MATCH',
                        Field: 'location',
                        Value: getRegionName(region)
                    },
                    {
                        Type: 'TERM_MATCH',
                        Field: 'tenancy',
                        Value: 'Shared'
                    },
                    {
                        Type: 'TERM_MATCH',
                        Field: 'operatingSystem',
                        Value: 'Linux'
                    },
                    {
                        Type: 'TERM_MATCH',
                        Field: 'preInstalledSw',
                        Value: 'NA'
                    },
                    {
                        Type: 'TERM_MATCH',
                        Field: 'capacitystatus',
                        Value: 'Used'
                    }
                ],
                MaxResults: 100
            };

            let nextToken = null;
            let regionRecords = 0;

            do {
                if (nextToken) {
                    params.NextToken = nextToken;
                }

                const command = new GetProductsCommand(params);
                const data = await pricingClient.send(command);

                for (const priceItem of data.PriceList || []) {
                    const product = JSON.parse(priceItem);
                    await insertPricingRecord(pool, product, region);
                    regionRecords++;
                }

                nextToken = data.NextToken;

                if (regionRecords % 100 === 0) {
                    console.log(`      ${regionRecords} records processed...`);
                }

            } while (nextToken);

            totalRecords += regionRecords;
            console.log(`    ✅ ${region}: ${regionRecords} records`);

        } catch (error) {
            console.error(`    ❌ ${region}: ${error.message}`);
        }
    }

    console.log(`  Total: ${totalRecords} records added`);
}

async function fetchSpotPricing(pool) {
    console.log('  Fetching spot pricing for all regions...');

    let totalRecords = 0;

    for (const region of ALL_REGIONS) {
        console.log(`    Processing ${region}...`);

        try {
            const ec2Client = new EC2Client({
                region,
                credentials: awsConfig.credentials
            });

            // Get spot price history (last 1 hour)
            const params = {
                StartTime: new Date(Date.now() - 3600000), // 1 hour ago
                ProductDescriptions: ['Linux/UNIX', 'Windows'],
                MaxResults: 1000
            };

            let nextToken = null;
            let regionRecords = 0;

            do {
                if (nextToken) {
                    params.NextToken = nextToken;
                }

                const command = new DescribeSpotPriceHistoryCommand(params);
                const data = await ec2Client.send(command);

                for (const spot of data.SpotPriceHistory || []) {
                    await insertSpotPricing(pool, spot, region);
                    regionRecords++;
                }

                nextToken = data.NextToken;

            } while (nextToken);

            totalRecords += regionRecords;
            console.log(`    ✅ ${region}: ${regionRecords} spot prices`);

        } catch (error) {
            console.error(`    ❌ ${region}: ${error.message}`);
        }
    }

    console.log(`  Total: ${totalRecords} spot pricing records added`);
}

async function fetchReservedPricing(pool) {
    console.log('  Fetching reserved instance pricing...');

    const pricingClient = new PricingClient(awsConfig);

    const terms = [1, 3]; // 1-year and 3-year
    const paymentOptions = ['All Upfront', 'Partial Upfront', 'No Upfront'];

    let totalRecords = 0;

    for (const region of ALL_REGIONS) {
        console.log(`    Processing ${region}...`);

        for (const term of terms) {
            for (const paymentOption of paymentOptions) {
                try {
                    const params = {
                        ServiceCode: 'AmazonEC2',
                        Filters: [
                            {
                                Type: 'TERM_MATCH',
                                Field: 'location',
                                Value: getRegionName(region)
                            },
                            {
                                Type: 'TERM_MATCH',
                                Field: 'termType',
                                Value: 'Reserved'
                            },
                            {
                                Type: 'TERM_MATCH',
                                Field: 'LeaseContractLength',
                                Value: `${term}yr`
                            },
                            {
                                Type: 'TERM_MATCH',
                                Field: 'PurchaseOption',
                                Value: paymentOption
                            }
                        ],
                        MaxResults: 100
                    };

                    let nextToken = null;
                    let count = 0;

                    do {
                        if (nextToken) {
                            params.NextToken = nextToken;
                        }

                        const command = new GetProductsCommand(params);
                        const data = await pricingClient.send(command);

                        for (const priceItem of data.PriceList || []) {
                            const product = JSON.parse(priceItem);
                            await insertReservedPricing(pool, product, region, term, paymentOption);
                            count++;
                        }

                        nextToken = data.NextToken;

                    } while (nextToken);

                    totalRecords += count;

                } catch (error) {
                    console.error(`      ❌ ${region} ${term}yr ${paymentOption}: ${error.message}`);
                }
            }
        }

        console.log(`    ✅ ${region} complete`);
    }

    console.log(`  Total: ${totalRecords} reserved pricing records added`);
}

async function fetchSavingsPlans(pool) {
    console.log('  Fetching savings plans...');

    const pricingClient = new PricingClient(awsConfig);

    // Savings Plans are region-agnostic but we'll fetch for each region
    let totalRecords = 0;

    try {
        const params = {
            ServiceCode: 'ComputeSavingsPlans',
            MaxResults: 100
        };

        let nextToken = null;

        do {
            if (nextToken) {
                params.NextToken = nextToken;
            }

            const command = new GetProductsCommand(params);
            const data = await pricingClient.send(command);

            for (const priceItem of data.PriceList || []) {
                const product = JSON.parse(priceItem);
                await insertSavingsPlan(pool, product);
                totalRecords++;
            }

            nextToken = data.NextToken;

        } while (nextToken);

        console.log(`  Total: ${totalRecords} savings plans added`);

    } catch (error) {
        console.error(`  ❌ Error: ${error.message}`);
    }
}

// Helper functions

function getRegionName(regionCode) {
    const regionNames = {
        'us-east-1': 'US East (N. Virginia)',
        'us-east-2': 'US East (Ohio)',
        'us-west-1': 'US West (N. California)',
        'us-west-2': 'US West (Oregon)',
        'us-west-3': 'US West (Las Vegas)',
        'ca-central-1': 'Canada (Central)',
        'eu-west-1': 'EU (Ireland)',
        'eu-west-2': 'EU (London)',
        'eu-west-3': 'EU (Paris)',
        'eu-central-1': 'EU (Frankfurt)',
        'eu-central-2': 'EU (Zurich)',
        'eu-north-1': 'EU (Stockholm)',
        'eu-south-1': 'EU (Milan)',
        'eu-south-2': 'EU (Spain)',
        'ap-northeast-1': 'Asia Pacific (Tokyo)',
        'ap-northeast-2': 'Asia Pacific (Seoul)',
        'ap-northeast-3': 'Asia Pacific (Osaka)',
        'ap-south-1': 'Asia Pacific (Mumbai)',
        'ap-south-2': 'Asia Pacific (Hyderabad)',
        'ap-southeast-1': 'Asia Pacific (Singapore)',
        'ap-southeast-2': 'Asia Pacific (Sydney)',
        'ap-southeast-3': 'Asia Pacific (Jakarta)',
        'ap-southeast-4': 'Asia Pacific (Melbourne)',
        'ap-east-1': 'Asia Pacific (Hong Kong)',
        'sa-east-1': 'South America (Sao Paulo)',
        'af-south-1': 'Africa (Cape Town)',
        'me-south-1': 'Middle East (Bahrain)',
        'me-central-1': 'Middle East (UAE)',
        'il-central-1': 'Israel (Tel Aviv)'
    };

    return regionNames[regionCode] || regionCode;
}

async function insertPricingRecord(pool, product, region) {
    try {
        const attributes = product.product.attributes;
        const terms = product.terms?.OnDemand;

        if (!terms) return;

        const termKey = Object.keys(terms)[0];
        const priceDimensions = terms[termKey]?.priceDimensions;

        if (!priceDimensions) return;

        const priceKey = Object.keys(priceDimensions)[0];
        const pricePerUnit = priceDimensions[priceKey]?.pricePerUnit?.USD;

        if (!pricePerUnit) return;

        const query = `
            INSERT INTO aws_pricing (
                region, instance_type, vcpu, memory_gb, storage, 
                network_performance, price_per_hour, currency, os, last_updated
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (region, instance_type, os) 
            DO UPDATE SET 
                price_per_hour = EXCLUDED.price_per_hour,
                last_updated = NOW()
        `;

        await pool.query(query, [
            region,
            attributes.instanceType,
            parseInt(attributes.vcpu) || 0,
            parseFloat(attributes.memory?.replace(' GiB', '')) || 0,
            attributes.storage || 'EBS only',
            attributes.networkPerformance || 'Unknown',
            parseFloat(pricePerUnit),
            'USD',
            attributes.operatingSystem || 'Linux',
        ]);
    } catch (error) {
        // Skip records with parsing errors
    }
}

async function insertSpotPricing(pool, spot, region) {
    const query = `
        INSERT INTO aws_spot_pricing (
            region, instance_type, os, availability_zone, 
            spot_price, currency, last_updated
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (region, instance_type, os, availability_zone) 
        DO UPDATE SET 
            spot_price = EXCLUDED.spot_price,
            last_updated = NOW()
    `;

    const os = spot.ProductDescription.includes('Windows') ? 'Windows' : 'Linux';

    await pool.query(query, [
        region,
        spot.InstanceType,
        os,
        spot.AvailabilityZone,
        parseFloat(spot.SpotPrice),
        'USD'
    ]);
}

async function insertReservedPricing(pool, product, region, term, paymentOption) {
    try {
        const attributes = product.product.attributes;
        const terms = product.terms?.Reserved;

        if (!terms) return;

        const termKey = Object.keys(terms)[0];
        const priceDimensions = terms[termKey]?.priceDimensions;

        if (!priceDimensions) return;

        const priceKey = Object.keys(priceDimensions)[0];
        const pricePerUnit = priceDimensions[priceKey]?.pricePerUnit?.USD;

        if (!pricePerUnit) return;

        const query = `
            INSERT INTO aws_reserved_pricing (
                region, instance_type, os, term_years, payment_option,
                upfront_cost, hourly_cost, effective_hourly_cost, currency, last_updated
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (region, instance_type, os, term_years, payment_option) 
            DO UPDATE SET 
                upfront_cost = EXCLUDED.upfront_cost,
                hourly_cost = EXCLUDED.hourly_cost,
                effective_hourly_cost = EXCLUDED.effective_hourly_cost,
                last_updated = NOW()
        `;

        const upfrontCost = parseFloat(terms[termKey]?.priceDimensions?.[priceKey]?.pricePerUnit?.USD || 0);
        const hourlyCost = parseFloat(pricePerUnit);
        const effectiveHourlyCost = (upfrontCost / (term * 8760)) + hourlyCost;

        await pool.query(query, [
            region,
            attributes.instanceType,
            attributes.operatingSystem || 'Linux',
            term,
            paymentOption,
            upfrontCost,
            hourlyCost,
            effectiveHourlyCost,
            'USD'
        ]);
    } catch (error) {
        // Skip records with parsing errors
    }
}

async function insertSavingsPlan(pool, product) {
    try {
        const attributes = product.product.attributes;
        const terms = product.terms?.SavingsPlan;

        if (!terms) return;

        const termKey = Object.keys(terms)[0];
        const rates = terms[termKey]?.rates;

        if (!rates) return;

        const rateKey = Object.keys(rates)[0];
        const discountRate = rates[rateKey]?.discountedRate?.USD;

        if (!discountRate) return;

        const query = `
            INSERT INTO aws_savings_plans (
                plan_type, term_years, payment_option, discount_rate, 
                currency, last_updated
            ) VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (plan_type, term_years, payment_option) 
            DO UPDATE SET 
                discount_rate = EXCLUDED.discount_rate,
                last_updated = NOW()
        `;

        await pool.query(query, [
            attributes.planType || 'Compute',
            parseInt(attributes.termLength) || 1,
            attributes.paymentOption || 'No Upfront',
            parseFloat(discountRate),
            'USD'
        ]);
    } catch (error) {
        // Skip records with parsing errors
    }
}

module.exports = fetchAWSData;
