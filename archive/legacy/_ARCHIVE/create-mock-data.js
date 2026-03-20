import fs from 'fs';
import path from 'path';

const outputDir = process.env.MOCK_OUTPUT_DIR || './data/mock/vendors';
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

if (outputDir === './data/vendors' || outputDir.replace(/\/+$/, '') === 'data/vendors') {
    console.warn('⚠ Warning: writing mock vendor data into ./data/vendors will overwrite real scraped data.');
    console.warn('  Consider using the default ./data/mock/vendors instead.');
}

const mockData = {
    apple_ios: [
        { os_version: 'iOS_16.4', max_emoji_version: '15.0', release_date: '2023-03-27' },
        { os_version: 'iOS_15.4', max_emoji_version: '14.0', release_date: '2022-03-14' },
        { os_version: 'iOS_14.5', max_emoji_version: '13.1', release_date: '2021-04-26' },
        { os_version: 'iOS_14.2', max_emoji_version: '13.0', release_date: '2020-11-05' },
        { os_version: 'iOS_13.2', max_emoji_version: '12.1', release_date: '2019-10-28' },
        { os_version: 'iOS_12.1', max_emoji_version: '11.0', release_date: '2018-10-30' },
        { os_version: 'iOS_11.1', max_emoji_version: '5.0', release_date: '2017-10-31' }, // Emoji 5.0 = Unicode 10.0
        { os_version: 'iOS_10.2', max_emoji_version: '4.0', release_date: '2016-12-12' }, // Emoji 4.0 = Unicode 9.0
        { os_version: 'iOS_9.1', max_emoji_version: '1.0', release_date: '2015-10-21' } // Emoji 1.0 = Unicode 8.0? Or earlier.
        // Note: 9.1 was Unicode 8.0/Emoji 1.0 era.
    ],
    google_android: [
        { os_version: 'Android_13.0', max_emoji_version: '15.0', release_date: '2022-08-15' },
        { os_version: 'Android_12.0', max_emoji_version: '14.0', release_date: '2021-10-04' },
        { os_version: 'Android_11.0', max_emoji_version: '13.0', release_date: '2020-09-08' },
        { os_version: 'Android_10.0', max_emoji_version: '12.0', release_date: '2019-09-03' }
    ],
    microsoft_windows: [
        { os_version: 'Win11_22H2', max_emoji_version: '14.0', release_date: '2022-09-20' }, // Supports 14.0? Actually Win 11 supports 15.0 in updates.
        { os_version: 'Win11', max_emoji_version: '13.1', release_date: '2021-10-05' },
        { os_version: 'Win10_1903', max_emoji_version: '12.0', release_date: '2019-05-21' }
    ]
};

for (const [vendor, data] of Object.entries(mockData)) {
    const fullData = data.map(entry => ({
        url: `https://mock.local/${vendor}/${entry.os_version}`,
        vendor: vendor,
        os_version: entry.os_version,
        release_date: entry.release_date,
        max_emoji_version: entry.max_emoji_version,
        emojis_found: 0,
        emojis: [], // Empty, relying on max_emoji_version explicit support
        is_mock: true
    }));

    fs.writeFileSync(path.join(outputDir, `${vendor}.json`), JSON.stringify(fullData, null, 2));
    console.log(`Created mock data for ${vendor}`);
}
