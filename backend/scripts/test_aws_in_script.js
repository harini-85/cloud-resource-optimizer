require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

console.log('Environment check:');
console.log('AWS_ACCESS_KEY_ID:', process.env.AWS_ACCESS_KEY_ID);
console.log('AWS_SECRET_ACCESS_KEY:', process.env.AWS_SECRET_ACCESS_KEY?.substring(0, 20) + '...');

async function test() {
    const client = new STSClient({
        region: 'us-east-1',
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    });

    try {
        const result = await client.send(new GetCallerIdentityCommand({}));
        console.log('\n✅ AWS Auth Success!');
        console.log('Account:', result.Account);
        console.log('ARN:', result.Arn);
    } catch (error) {
        console.log('\n❌ AWS Auth Failed:', error.message);
    }
}

test();
