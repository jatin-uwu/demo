const cds = require('@sap/cds');

const INCIDENT_NUMBER_PREFIX = 'INC-';
const INCIDENT_NUMBER_SEED = 22938;

module.exports = cds.service.impl(async function () {

    const { Incident } = this.entities;

    // Register Event Handlers
    this.on('nextIncidentNumber', onNextIncidentNumber);

    this.before('CREATE', Incident, beforeCreateIncident);

    this.before(['CREATE', 'UPDATE'], Incident, validateCategories);

});


// =======================================================
// Action Handler
// =======================================================

async function onNextIncidentNumber(req) {

    const { Incident } = cds.entities;

    return await computeNextIncidentNumber(Incident);

}


// =======================================================
// Before CREATE
// =======================================================

async function beforeCreateIncident(req) {

    const { Incident } = cds.entities;

    req.data.incidentNumber =
        await computeNextIncidentNumber(Incident);

}


// =======================================================
// Category Validation
// =======================================================

async function validateCategories(req) {

    const { Incident } = cds.entities;
    const { LookupValue } = cds.entities('itsm');

    const levels = categoryLevels(Incident);

    const touchesCategories =
        levels.some(level => level in req.data);

    if (!touchesCategories)
        return;

    let record = req.data;

    if (req.event === 'UPDATE' && req.data.ID) {

        const stored = await SELECT.one
            .from(Incident)
            .where({
                ID: req.data.ID
            });

        if (stored) {

            record = {
                ...stored,
                ...req.data
            };

        }

    }

    const selected =
        levels.map(level => record[level] || null);

    const ids =
        selected.filter(Boolean);

    if (!ids.length)
        return;

    const rows = await SELECT
        .from(LookupValue)
        .columns(
            'ID',
            'name',
            'parent_ID'
        )
        .where({
            ID: {
                in: ids
            }
        });

    const byId =
        new Map(rows.map(row => [row.ID, row]));

    for (let i = 0; i < levels.length; i++) {

        const childId = selected[i];

        if (!childId)
            continue;

        const child = byId.get(childId);

        if (!child) {

            req.error(
                400,
                `Category ${i + 1} is not a known category.`,
                levels[i]
            );

            continue;
        }

        const parentId =
            i === 0
                ? null
                : selected[i - 1];

        if (i > 0 && !parentId) {

            req.error(
                400,
                `Category ${i + 1} requires Category ${i} to be selected.`,
                levels[i]
            );

            continue;
        }

        if ((child.parent_ID || null) !== parentId) {

            const parentName =
                parentId
                    ? (byId.get(parentId) || {}).name || parentId
                    : 'none';

            req.error(
                400,
                `"${child.name}" is not a valid Category ${i + 1} for the selected Category ${i || 1} ("${parentName}").`,
                levels[i]
            );

        }

    }

}


// =======================================================
// Helper Functions
// =======================================================

function categoryLevels(entity) {

    return Object.keys(entity.elements)
        .map(name => /^category(\d+)$/.exec(name))
        .filter(Boolean)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map(match => `${match[0]}_ID`);

}


async function computeNextIncidentNumber(Incident) {

    const rows = await SELECT
        .from(Incident)
        .columns('incidentNumber');

    let max = INCIDENT_NUMBER_SEED;

    for (const row of rows) {

        const match =
            /^INC-(\d+)$/.exec(row.incidentNumber || '');

        if (match) {

            max = Math.max(
                max,
                Number(match[1])
            );

        }

    }

    return INCIDENT_NUMBER_PREFIX + (max + 1);

}