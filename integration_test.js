const { RateLimiter, sendFilesInGroups } = require('./bot.js');
const fs = require('fs');

// Mock Telegram context
const mockCtx = {
    chat: { id: 'test-chat' },
    telegram: {
        sendMediaGroup: async (chatId, media) => {
            console.log(`Mock: Sending ${media.length} files to chat ${chatId}`);
            return Promise.resolve();
        }
    },
    reply: async (message) => {
        console.log('Mock: Bot reply:', message);
        return Promise.resolve();
    }
};

async function runTests() {
    console.log('\n=== Starting Integration Tests ===\n');

    // Test 1: RateLimiter
    console.log('Test 1: RateLimiter');
    const rateLimiter = new RateLimiter(1000);
    try {
        console.log('Adding task to rate limiter...');
        const result = await rateLimiter.add(async () => {
            console.log('Executing rate-limited task');
            return 'Success';
        });
        console.log('RateLimiter test result:', result);
    } catch (error) {
        console.error('RateLimiter test failed:', error);
    }

    // Test 2: sendFilesInGroups
    console.log('\nTest 2: sendFilesInGroups');
    
    // Create test files
    const testFiles = [];
    for (let i = 1; i <= 3; i++) {
        const path = `./test_file_${i}.txt`;
        fs.writeFileSync(path, `Test content ${i}`);
        testFiles.push({ path });
        console.log(`Created test file: ${path}`);
    }

    try {
        console.log('Sending test files...');
        const result = await sendFilesInGroups(mockCtx, testFiles);
        console.log('sendFilesInGroups result:', result);
    } catch (error) {
        console.error('sendFilesInGroups test failed:', error);
    }

    // Cleanup test files (they should already be cleaned up by sendFilesInGroups)
    testFiles.forEach(file => {
        try {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
                console.log(`Cleaned up remaining test file: ${file.path}`);
            }
        } catch (error) {
            console.error('Error cleaning up file:', file.path, error);
        }
    });

    console.log('\n=== Tests Completed ===\n');
}

// Run tests
console.log('Starting tests...');
runTests().catch(console.error);
