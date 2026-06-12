// Test setup file
const mongoose = require('mongoose');

// Set test environment
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key';
process.env.MONGODB_URI = 'mongodb://localhost:27017/cloud-optimizer-test';

// Increase timeout for property-based tests
jest.setTimeout(30000);

// Connect to test database before all tests
beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
});

// Clean up after each test
afterEach(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        await collections[key].deleteMany({});
    }
});

// Close database connection after all tests
afterAll(async () => {
    await mongoose.connection.close();
});
