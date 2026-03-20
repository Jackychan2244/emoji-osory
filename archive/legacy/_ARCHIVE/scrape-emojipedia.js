// scrape-emojipedia.js
// Scrapes vendor emoji release pages with proper error handling

import fs from 'fs';
import path from 'path';

class EmojipediaScraper {
    constructor(outputDir = './data/vendors') {
        this.outputDir = outputDir;
        this.retryDelayMs = 2000;
        this.maxRetries = 3;

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
    }

    /**
     * Fetch with retry logic and rate limiting
     */
    async fetchWithRetry(url, retries = 0) {
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Accept': 'text/html',
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return await response.text();
        } catch (error) {
            if (retries < this.maxRetries) {
                console.log(`  Retry ${retries + 1}/${this.maxRetries} after error: ${error.message}`);
                await this.sleep(this.retryDelayMs * (retries + 1));
                return this.fetchWithRetry(url, retries + 1);
            }
            throw error;
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Extract emoji version from page text
     */
    extractEmojiVersion(html) {
        // Look for patterns like "Emoji 14.0", "supports Emoji 15.1", etc.
        const patterns = [
            /(?:supports?|includes?|adds?|introduces?)\s+Emoji\s+(\d+(?:\.\d+)?)/i,
            /Emoji\s+(\d+(?:\.\d+)?)\s+(?:support|release|update)/i,
            /(?:Unicode|Emoji)\s+(\d+(?:\.\d+)?)\s+emojis?/i
        ];

        const versions = new Set();

        for (const pattern of patterns) {
            const matches = html.matchAll(new RegExp(pattern.source, 'gi'));
            for (const match of matches) {
                versions.add(match[1]);
            }
        }

        return [...versions].sort((a, b) => parseFloat(b) - parseFloat(a));
    }

    /**
     * Extract emoji list from page
     */
    extractEmojis(html) {
        const emojis = [];
        // Strict pattern: Group 1 MUST be emoji chars only
        const emojiPattern = /href=.*?\\u003e([\p{Emoji}]+)\\u0026nbsp;(.*?)\\u003c\/a/gu;

        let match;
        while ((match = emojiPattern.exec(html)) !== null) {
            const [, emojiChar, name] = match;
            if (emojiChar && /\p{Emoji}/u.test(emojiChar)) {
                emojis.push({
                    char: emojiChar,
                    name: name.trim()
                });
            }
        }

        // Fallback: extract from emoji grid if list fails
        if (emojis.length === 0) {
            const gridPattern = /<span[^>]+class=["'][^"']*emoji[^"']*["'][^>]*>([^\s<]+)<\/span>/g;
            while ((match = gridPattern.exec(html)) !== null) {
                const char = match[1].trim();
                if (char && /\p{Emoji}/u.test(char)) {
                    emojis.push({ char, name: '' });
                }
            }
        }

        // Last fallback: Look for "New Emojis" section logic or just simple regex for all emojis if critical
        // But for now, let's trust the loose pattern which worked on debug page.

        return emojis;
    }

    /**
     * Extract release date
     */
    extractReleaseDate(html) {
        const patterns = [
            /released?\s+(?:on\s+)?(\d{1,2}\s+\w+\s+\d{4})/i,
            /(\d{4}-\d{2}-\d{2})/,
            /<time[^>]+datetime=["']([^"']+)["']/i
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) {
                return match[1];
            }
        }

        return null;
    }

    /**
     * Scrape a single vendor page
     */
    async scrapePage(url, vendorKey, osVersion) {
        console.log(`Scraping: ${url}`);

        try {
            const html = await this.fetchWithRetry(url);

            const emojiVersions = this.extractEmojiVersion(html);
            const emojis = this.extractEmojis(html);
            const releaseDate = this.extractReleaseDate(html);

            const result = {
                url,
                vendor: vendorKey,
                os_version: osVersion,
                release_date: releaseDate,
                emoji_versions_mentioned: emojiVersions,
                max_emoji_version: emojiVersions[0] || null,
                emojis_found: emojis.length,
                emojis: emojis,
                scraped_at: new Date().toISOString()
            };

            console.log(`  ✓ Found: ${emojiVersions[0] || 'unknown version'}, ${emojis.length} emojis`);

            return result;
        } catch (error) {
            console.error(`  ✗ Error: ${error.message}`);
            return {
                url,
                vendor: vendorKey,
                os_version: osVersion,
                error: error.message,
                scraped_at: new Date().toISOString()
            };
        }
    }

    /**
     * Scrape all vendor pages
     */
    async scrapeAll(vendorUrls) {
        const results = {};

        for (const [vendorKey, urls] of Object.entries(vendorUrls)) {
            console.log(`\n=== ${vendorKey.toUpperCase()} ===`);
            results[vendorKey] = [];

            for (const { url, version } of urls) {
                const result = await this.scrapePage(url, vendorKey, version);
                results[vendorKey].push(result);

                // Rate limiting: wait between requests
                await this.sleep(1500);
            }

            // Save intermediate results
            this.saveVendorData(vendorKey, results[vendorKey]);
        }

        return results;
    }

    /**
     * Save vendor data to JSON
     */
    saveVendorData(vendorKey, data) {
        const filePath = path.join(this.outputDir, `${vendorKey}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        console.log(`  → Saved to ${filePath}`);
    }
}

// Vendor URLs configuration
const vendorUrls = {
    apple_ios: [
        { url: 'https://emojipedia.org/apple/ios-9.1', version: 'iOS_9.1' },
        { url: 'https://emojipedia.org/apple/ios-10.2', version: 'iOS_10.2' },
        { url: 'https://emojipedia.org/apple/ios-11.1', version: 'iOS_11.1' },
        { url: 'https://emojipedia.org/apple/ios-12.1', version: 'iOS_12.1' },
        { url: 'https://emojipedia.org/apple/ios-13.2', version: 'iOS_13.2' },
        { url: 'https://emojipedia.org/apple/ios-14.2', version: 'iOS_14.2' },
        { url: 'https://emojipedia.org/apple/ios-14.5', version: 'iOS_14.5' },
        { url: 'https://emojipedia.org/apple/ios-15.4', version: 'iOS_15.4' },
        { url: 'https://emojipedia.org/apple/ios-16.4', version: 'iOS_16.4' },
        { url: 'https://emojipedia.org/apple/ios-17.4', version: 'iOS_17.4' },
        { url: 'https://emojipedia.org/apple/ios-18.2', version: 'iOS_18.2' }
    ],
    apple_macos: [
        { url: 'https://emojipedia.org/apple/macos-10.12.2', version: 'macOS_10.12' },
        { url: 'https://emojipedia.org/apple/macos-10.13', version: 'macOS_10.13' },
        { url: 'https://emojipedia.org/apple/macos-11.1', version: 'macOS_11' },
        { url: 'https://emojipedia.org/apple/macos-12.3', version: 'macOS_12' },
        { url: 'https://emojipedia.org/apple/macos-13', version: 'macOS_13' },
        { url: 'https://emojipedia.org/apple/macos-14', version: 'macOS_14' },
        { url: 'https://emojipedia.org/apple/macos-15', version: 'macOS_15' }
    ],
    google_android: [
        { url: 'https://emojipedia.org/google/android-6.0.1', version: 'Android_6.0' },
        { url: 'https://emojipedia.org/google/android-7.0', version: 'Android_7.0' },
        { url: 'https://emojipedia.org/google/android-8.0', version: 'Android_8.0' },
        { url: 'https://emojipedia.org/google/android-9.0', version: 'Android_9.0' },
        { url: 'https://emojipedia.org/google/android-10.0', version: 'Android_10.0' },
        { url: 'https://emojipedia.org/google/android-11.0', version: 'Android_11.0' },
        { url: 'https://emojipedia.org/google/android-12.0', version: 'Android_12.0' },
        { url: 'https://emojipedia.org/google/android-12l', version: 'Android_12L' },
        { url: 'https://emojipedia.org/google/android-13.0', version: 'Android_13.0' },
        { url: 'https://emojipedia.org/google/android-14.0', version: 'Android_14.0' },
        { url: 'https://emojipedia.org/google/android-15.0', version: 'Android_15.0' }
    ],
    microsoft_windows: [
        { url: 'https://emojipedia.org/microsoft/windows-10-anniversary-update', version: 'Win10_1607' },
        { url: 'https://emojipedia.org/microsoft/windows-10-fall-creators-update', version: 'Win10_1709' },
        { url: 'https://emojipedia.org/microsoft/windows-10-may-2019-update', version: 'Win10_1903' },
        { url: 'https://emojipedia.org/microsoft/windows-11', version: 'Win11' },
        { url: 'https://emojipedia.org/microsoft/windows-11-22h2', version: 'Win11_22H2' },
        { url: 'https://emojipedia.org/microsoft/windows-11-23h2', version: 'Win11_23H2' }
    ],
    samsung_oneui: [
        { url: 'https://emojipedia.org/samsung/one-ui-1.0', version: 'OneUI_1.0' },
        { url: 'https://emojipedia.org/samsung/one-ui-2.5', version: 'OneUI_2.5' },
        { url: 'https://emojipedia.org/samsung/one-ui-4.0', version: 'OneUI_4.0' },
        { url: 'https://emojipedia.org/samsung/one-ui-5.0', version: 'OneUI_5.0' },
        { url: 'https://emojipedia.org/samsung/one-ui-6.0', version: 'OneUI_6.0' }
    ]
};

// Main execution
const scraper = new EmojipediaScraper();

console.log('Starting Emojipedia scrape...\n');
console.log('This will take several minutes due to rate limiting.\n');

scraper.scrapeAll(vendorUrls).then(() => {
    console.log('\n✓ Scraping complete! Check ./data/vendors/ for results.');
}).catch(error => {
    console.error('\n✗ Fatal error:', error);
});

export default EmojipediaScraper;