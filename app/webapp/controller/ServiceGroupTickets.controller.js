sap.ui.define([
  "itsm/ui/controller/Dashboard.controller",
  "sap/ui/model/json/JSONModel"
], function (DashboardController, JSONModel) {
  "use strict";

  // The Service Group "View Tickets" / ticket-table page. It reuses the Agent
  // dashboard's tile + table behaviour by EXTENDING that controller, so all of
  // the tile/filter/search/assign/formatter logic is inherited unchanged and
  // the matching view reuses the same control ids.
  //
  // Differences from the Agent dashboard, on purpose:
  //   - No "Create Ticket" (the Service Group works existing tickets).
  //   - A back button returning to the Service Group operational dashboard.
  //   - No Category-Wise Breakdown chart (removed from the view), so onInit
  //     below is the parent's setup WITHOUT the chart-configuration step
  //     (the only part that needs a categoryChart control to exist).
  //
  // Ticket visibility stays role-specific server-side (srv onReadTicket): the
  // Service Group sees ALL tickets here; reusing the Agent UI doesn't change that.
  return DashboardController.extend("itsm.ui.controller.ServiceGroupTickets", {

    onInit: function () {
      // Mirrors the Agent Dashboard controller's onInit, minus the single
      // categoryChart.setVizProperties(...) call (this page has no chart) and
      // wired to the "sgTickets" route instead of "dashboard". Everything it
      // calls (_buildTiles, _loadCounts, _loadCurrentUser, formatters, …) is
      // inherited from the Agent Dashboard controller.
      this._aSelectedTileKeys = this._loadTileKeyPref();
      this._aSelectedFilterKeys = this._loadFilterKeyPref();
      this._aSelectedColumnKeys = this._loadColumnKeyPref();

      this.getView().setModel(new JSONModel({
        tiles: this._buildTiles(),
        categoryData: [],
        tableTitle: "All Incidents"
      }), "dash");

      this.getView().setModel(new JSONModel(this._buildColsVisibility()), "cols");

      this.getView().setModel(new JSONModel({
        hasSelection: false, canDelete: false, isServiceGroup: false, isAdmin: false
      }), "sel");
      this._loadCurrentUser();

      this._mStatusName = {};
      this._mPriorityName = {};
      this._mImpactName = {};
      this._mUrgencyName = {};
      this._mCategoryName = {};
      this._mUserNames = {};
      this._loadLookupMaps();

      this._sStatusCode = null;
      this._sActiveTileKey = "ALL";

      // Refresh tiles/table every time the Service Group lands on this page.
      this.getOwnerComponent().getRouter()
        .getRoute("sgTickets")
        .attachPatternMatched(this._onMatched, this);

      this._loadCounts();
      this._loadFilterOptions();

      this._syncTileClasses();
    },

    // Back button returns to the Service Group operational dashboard this page
    // is opened from (the Agent dashboard has no back button; this one does).
    onBack: function () {
      this.getOwnerComponent().getRouter().navTo("serviceGroupDashboard");
    },

    // Logo tap also goes to the Service Group dashboard rather than the Agent
    // landing dashboard, so the Service Group never lands on the Agent home.
    onGoDashboard: function () {
      this.getOwnerComponent().getRouter().navTo("serviceGroupDashboard");
    }

    // Everything else — onTilePress, onFilterChange, onSearch, onManageTiles,
    // onManageTableSettings, onBulkAssign/onConfirmAssign, onBulkDelete,
    // onTicketPress, onGoAnalytics, all formatters, etc. — is inherited
    // unchanged from the Agent Dashboard controller.
  });
});
