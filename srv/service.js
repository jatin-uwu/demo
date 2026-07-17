const cds = require('@sap/cds');

/**
 * Returns the category levels declared on the entity, in order:
 * ['category1_ID', 'category2_ID', ...]. Derived from the model, so adding a
 * category5 to the schema extends validation with no change here.
 */
function categoryLevels(entity) {
  return Object.keys(entity.elements)
    .map(name => /^category(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map(match => `${match[0]}_ID`);
}

module.exports = cds.service.impl(async function () {
  const { Incident } = this.entities;
  const { LookupValue } = cds.entities('itsm');
  const levels = categoryLevels(Incident);

  /**
   * A child category must actually belong to the parent chosen one level up.
   * Guards the API directly, not just the UI.
   */
  this.before(['CREATE', 'UPDATE'], Incident, async (req) => {
    const touchesCategories = levels.some(level => level in req.data);
    if (!touchesCategories) return;

    // On UPDATE the payload may carry only some levels, so validate the
    // resulting record rather than the patch alone.
    let record = req.data;
    if (req.event === 'UPDATE' && req.data.ID) {
      const stored = await SELECT.one.from(Incident).where({ ID: req.data.ID });
      if (stored) record = { ...stored, ...req.data };
    }

    const selected = levels.map(level => record[level] || null);
    const ids = selected.filter(Boolean);
    if (!ids.length) return;

    const rows = await SELECT.from(LookupValue)
      .columns('ID', 'name', 'parent_ID')
      .where({ ID: { in: ids } });
    const byId = new Map(rows.map(row => [row.ID, row]));

    for (let i = 0; i < levels.length; i++) {
      const childId = selected[i];
      if (!childId) continue;

      const child = byId.get(childId);
      if (!child) {
        req.error(400, `Category ${i + 1} is not a known category.`, levels[i]);
        continue;
      }

      // A gap in the chain would leave the child unreachable in the UI.
      const parentId = i === 0 ? null : selected[i - 1];
      if (i > 0 && !parentId) {
        req.error(400, `Category ${i + 1} requires Category ${i} to be selected.`, levels[i]);
        continue;
      }

      if ((child.parent_ID || null) !== parentId) {
        const parentName = parentId ? (byId.get(parentId) || {}).name || parentId : 'none';
        req.error(
          400,
          `"${child.name}" is not a valid Category ${i + 1} for the selected Category ${i || 1} ("${parentName}").`,
          levels[i]
        );
      }
    }
  });
});
