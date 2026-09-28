/**
 * Fetch HubSpot Deal Properties
 * Retrieves all deal fields from HubSpot and saves them to a JSON file
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const client = axios.create({
    baseURL: 'https://api.hubapi.com',
    headers: {
        'Authorization': `Bearer ${process.env.HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
    }
});

async function getDealProperties() {
    try {
        console.log('Fetching deal properties from HubSpot...\n');

        const response = await client.get('/crm/v3/properties/deals');
        const properties = response.data.results.map(prop => ({
            name: prop.name,
            label: prop.label,
            type: prop.type,
            fieldType: prop.fieldType,
            groupName: prop.groupName,
            description: prop.description || ''
        }));

        // Sort by name
        properties.sort((a, b) => a.name.localeCompare(b.name));

        // Save to JSON file
        const outputPath = path.join(__dirname, '..', 'hubspot-deal-properties.json');
        fs.writeFileSync(outputPath, JSON.stringify(properties, null, 2));

        console.log(`✓ Found ${properties.length} deal properties`);
        console.log(`✓ Saved to: ${outputPath}\n`);

        // Display summary by type
        const typeCount = {};
        properties.forEach(prop => {
            typeCount[prop.type] = (typeCount[prop.type] || 0) + 1;
        });

        console.log('Properties by type:');
        Object.entries(typeCount).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
            console.log(`  ${type}: ${count}`);
        });

        return properties;

    } catch (error) {
        console.error('Error fetching deal properties:', error.response?.data || error.message);
        process.exit(1);
    }
}

getDealProperties();
