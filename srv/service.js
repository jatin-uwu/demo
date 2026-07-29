const cds = require('@sap/cds');

const INCIDENT_NUMBER_PREFIX = 'INC-';
const INCIDENT_NUMBER_SEED = 22938;

// STATUS LookupValue codes that mark "first response" (leaving NEW) and
// "resolved" (SLA clock stops). Matches the codes in db/data/itsm-LookupValue.csv.
const STATUS_CODE_NEW = 'NEW';
const RESOLVED_STATUS_CODES = ['CONFIRMED', 'CLOSED'];

// Editable fields worth showing on the change-history timeline, mapped to
// the label the user sees on the form.
const FIELD_LABELS = {
    userId: 'User ID',
    reportedBy: 'Reported By',
    supportTeam: 'Support Team',
    messageProcessor: 'Assigned To',
    shortDescription: 'Short Description',
    description: 'Full Description',
    impact_ID: 'Impact',
    urgency_ID: 'Urgency',
    priority_ID: 'Final Priority',
    status_ID: 'Status',
    category1_ID: 'Category 1',
    category2_ID: 'Category 2',
    category3_ID: 'Category 3',
    category4_ID: 'Category 4',
    solutionCategory_ID: 'Solution Category'
};

module.exports = cds.service.impl(async function () {

    const { Incident } = this.entities;

    // Register Event Handlers
    this.on('nextIncidentNumber', onNextIncidentNumber);

    this.before('CREATE', Incident, beforeCreateIncident);

    this.before(['CREATE', 'UPDATE'], Incident, validateCategories);

    this.before('UPDATE', Incident, trackIncidentChanges);

    this.before('UPDATE', Incident, stampSlaTimestamps);

    this.after('CREATE', Incident, afterCreateIncident);

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
// Change History (drives the ticket's timeline)
// =======================================================

async function afterCreateIncident(data) {

    const { IncidentHistory } = cds.entities('itsm');

    await INSERT.into(IncidentHistory).entries({
        incident_ID: data.ID,
        changeType: 'CREATE',
        fieldLabel: null,
        oldValue: null,
        newValue: null
    });

}

async function trackIncidentChanges(req) {

    const { Incident, IncidentHistory, LookupValue } = cds.entities('itsm');

    if (!req.data.ID)
        return;

    const stored = await SELECT.one
        .from(Incident)
        .where({ ID: req.data.ID });

    if (!stored)
        return;

    const changes = Object.keys(FIELD_LABELS)
        .filter(field => field in req.data)
        .filter(field => (req.data[field] || null) !== (stored[field] || null))
        .map(field => ({
            field,
            oldValue: stored[field] || null,
            newValue: req.data[field] || null
        }));

    if (!changes.length)
        return;

    // Association fields carry an ID — resolve both sides to the
    // human-readable name so the timeline reads "Status changed from
    // New to In Process" instead of raw GUIDs.
    const lookupIds = changes
        .filter(c => c.field.endsWith('_ID'))
        .flatMap(c => [c.oldValue, c.newValue])
        .filter(Boolean);

    let namesById = {};

    if (lookupIds.length) {
        const rows = await SELECT.from(LookupValue)
            .columns('ID', 'name')
            .where({ ID: { in: lookupIds } });
        namesById = Object.fromEntries(rows.map(r => [r.ID, r.name]));
    }

    const historyRows = changes.map(c => {
        const isLookup = c.field.endsWith('_ID');
        return {
            incident_ID: req.data.ID,
            changeType: 'UPDATE',
            fieldLabel: FIELD_LABELS[c.field],
            oldValue: isLookup ? (namesById[c.oldValue] || null) : c.oldValue,
            newValue: isLookup ? (namesById[c.newValue] || null) : c.newValue
        };
    });

    await INSERT.into(IncidentHistory).entries(historyRows);

}

/* ---------------------------------------------------------
 * SLA timestamps — the UI computes on-track/due/breached against
 * these, matched to each priority's response/resolution window.
 * firstResponseOn is stamped the first time a ticket leaves NEW;
 * completedOn the first time it reaches CONFIRMED or CLOSED. Both
 * are set once only — a ticket bouncing back to an earlier status
 * later doesn't reset or erase either clock.
 * ------------------------------------------------------- */
async function stampSlaTimestamps(req) {

    if (!req.data.ID || !('status_ID' in req.data))
        return;

    const { Incident, LookupValue } = cds.entities('itsm');

    const stored = await SELECT.one
        .from(Incident)
        .columns('status_ID', 'firstResponseOn', 'completedOn')
        .where({ ID: req.data.ID });

    if (!stored || req.data.status_ID === stored.status_ID)
        return;

    const rows = await SELECT.from(LookupValue)
        .columns('ID', 'code')
        .where({ ID: [stored.status_ID, req.data.status_ID].filter(Boolean) });

    const codeById = Object.fromEntries(rows.map(r => [r.ID, r.code]));
    const sOldCode = codeById[stored.status_ID];
    const sNewCode = codeById[req.data.status_ID];

    const sNow = new Date().toISOString();

    if (sOldCode === STATUS_CODE_NEW && !stored.firstResponseOn) {
        req.data.firstResponseOn = sNow;
    }

    if (RESOLVED_STATUS_CODES.includes(sNewCode) && !stored.completedOn) {
        req.data.completedOn = sNow;
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