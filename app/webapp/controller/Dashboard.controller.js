sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (Controller, JSONModel, Filter, FilterOperator) {
  "use strict";

  // The status tiles we want to show, in order. `code` matches the STATUS
  // LookupValue codes in the DB; `code: null` means "all tickets".
  // Colours use NumericContent value states: Good / Critical / Error / Neutral.
  var STATUS_TILES = [
    { key: "ALL",               label: "Total",             code: null,                color: "Neutral",  icon: "sap-icon://sum" },
    { key: "NEW",               label: "New",               code: "NEW",               color: "Neutral",  icon: "sap-icon://create" },
    { key: "IN_PROCESS",        label: "In Process",        code: "IN_PROCESS",        color: "Critical", icon: "sap-icon://work-history" },
    { key: "CUSTOMER_ACTION",   label: "Customer Action",   code: "CUSTOMER_ACTION",   color: "Critical", icon: "sap-icon://pending" },
    { key: "SOLUTION_PROPOSED", label: "Solution Proposed", code: "SOLUTION_PROPOSED", color: "Neutral",  icon: "sap-icon://lightbulb" },
    { key: "CONFIRMED",         label: "Confirmed",         code: "CONFIRMED",         color: "Good",     icon: "sap-icon://accept" },
    { key: "CLOSED",            label: "Closed",            code: "CLOSED",            color: "Good",     icon: "sap-icon://sys-enter-2" }
  ];

  return Controller.extend("itsm.ui.controller.Dashboard", {

    onInit: function () {
      // Local model that drives tiles, chart data and the table title.
      this.getView().setModel(new JSONModel({
        tiles: STATUS_TILES.map(function (t) {
          return { key: t.key, label: t.label, code: t.code, color: t.color, icon: t.icon, count: 0, selected: t.key === "ALL" };
        }),
        categoryData: [],
        tableTitle: "All Incidents"
      }), "dash");

      // Currently active filters.
      this._sStatusCode = null;   // from the selected tile
      this._sCategory   = null;   // from the chart selection

      // Recompute every time we land here so newly created tickets show up.
      this.getOwnerComponent().getRouter()
        .getRoute("dashboard")
        .attachPatternMatched(this._onMatched, this);

      // Also load immediately: on the initial (landing) load the route's
      // patternMatched can fire before this handler is attached, so the
      // first paint would otherwise show zeros.
      this._loadCounts();
    },

    _onMatched: function () {
      this._loadCounts();
      // Refresh the table binding too (a ticket may have been created).
      var oBinding = this.byId("dashTable").getBinding("items");
      if (oBinding) { oBinding.refresh(); }
    },

    /* ---------------------------------------------------------
     * Pull every incident once (only the fields we need) and
     * compute all tile counts + the category breakdown from it.
     * One request instead of one-per-tile.
     * ------------------------------------------------------- */
    _loadCounts: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();

      // Read only flat, primitive fields — no nested navigation access
      // (getProperty("status/code") on an expand is not reliable in v4).
      // We map the foreign keys to codes/names via the Lookup entity instead.
      var oStatusB = oModel.bindList("/Lookup", null, [], [
        new Filter("lookupType", FilterOperator.EQ, "STATUS")
      ], { $select: "ID,code" });

      var oCatB = oModel.bindList("/Lookup", null, [], [
        new Filter("lookupType", FilterOperator.EQ, "CATEGORY1")
      ], { $select: "ID,name" });

      var oIncB = oModel.bindList("/Incident", null, [], [], {
        $select: "ID,status_ID,category1_ID"
      });

      Promise.all([
        oStatusB.requestContexts(0, 999),
        oCatB.requestContexts(0, 999),
        oIncB.requestContexts(0, 9999)
      ]).then(function (aRes) {
        // id -> code / name maps
        var mStatusCode = {};
        aRes[0].forEach(function (c) { mStatusCode[c.getProperty("ID")] = c.getProperty("code"); });
        var mCatName = {};
        aRes[1].forEach(function (c) { mCatName[c.getProperty("ID")] = c.getProperty("name"); });

        var mStatusCount = {};   // code -> count
        var mCatCount = {};      // category name -> count
        var aInc = aRes[2];
        var iTotal = aInc.length;

        aInc.forEach(function (oCtx) {
          var sStatusId = oCtx.getProperty("status_ID");
          var sCode = sStatusId && mStatusCode[sStatusId];
          if (sCode) { mStatusCount[sCode] = (mStatusCount[sCode] || 0) + 1; }

          var sCatId = oCtx.getProperty("category1_ID");
          var sName = sCatId && mCatName[sCatId];
          if (sName) { mCatCount[sName] = (mCatCount[sName] || 0) + 1; }
        });

        // Diagnostic — remove once verified. Shows in the browser console.
        // eslint-disable-next-line no-console
        console.log("[Dashboard] incidents:", iTotal, "byStatus:", mStatusCount, "byCategory:", mCatCount);

        var oDash = that.getView().getModel("dash");

        // Tiles
        var aTiles = oDash.getProperty("/tiles").map(function (t) {
          t.count = (t.code === null) ? iTotal : (mStatusCount[t.code] || 0);
          return t;
        });
        oDash.setProperty("/tiles", aTiles);

        // Category chart data
        var aCatData = Object.keys(mCatCount).map(function (sName) {
          return { name: sName, count: mCatCount[sName] };
        });
        oDash.setProperty("/categoryData", aCatData);
      }).catch(function (oErr) {
        // eslint-disable-next-line no-console
        console.error("Dashboard counts failed:", oErr);
      });
    },

    /* ---------------------------------------------------------
     * Tile click -> becomes the status filter for the table.
     * ------------------------------------------------------- */
    onTilePress: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("dash");
      if (!oCtx) { return; }

      var sKey  = oCtx.getProperty("key");
      var sCode = oCtx.getProperty("code");
      var sLabel = oCtx.getProperty("label");

      // Highlight the chosen tile, clear the rest.
      var oDash = this.getView().getModel("dash");
      var aTiles = oDash.getProperty("/tiles").map(function (t) {
        t.selected = (t.key === sKey);
        return t;
      });
      oDash.setProperty("/tiles", aTiles);

      this._sStatusCode = sCode;   // null for "Total"
      oDash.setProperty("/tableTitle", sCode ? (sLabel + " Incidents") : "All Incidents");
      this._applyFilters();
    },

    /* ---------------------------------------------------------
     * Chart segment click -> adds a category filter (combined
     * with whatever status tile is active).
     * ------------------------------------------------------- */
    onChartSelect: function (oEvent) {
      var aData = oEvent.getParameter("data");
      if (aData && aData.length && aData[0].data) {
        this._sCategory = aData[0].data.Category;
        this._applyFilters();
      }
    },

    onResetFilters: function () {
      this._sStatusCode = null;
      this._sCategory = null;

      var oDash = this.getView().getModel("dash");
      var aTiles = oDash.getProperty("/tiles").map(function (t) {
        t.selected = (t.key === "ALL");
        return t;
      });
      oDash.setProperty("/tiles", aTiles);
      oDash.setProperty("/tableTitle", "All Incidents");

      var oChart = this.byId("categoryChart");
      if (oChart && oChart.vizSelection) { oChart.vizSelection([]); }

      this._sSearch = null;
      this._applyFilters();
    },

    /* ---------------------------------------------------------
     * Combine status + category + search into one filter set and
     * apply it to the table binding.
     * ------------------------------------------------------- */
    _applyFilters: function () {
      var aFilters = [];

      if (this._sStatusCode) {
        aFilters.push(new Filter("status/code", FilterOperator.EQ, this._sStatusCode));
      }
      if (this._sCategory) {
        aFilters.push(new Filter("category1/name", FilterOperator.EQ, this._sCategory));
      }
      if (this._sSearch) {
        aFilters.push(new Filter({
          filters: [
            new Filter("incidentNumber", FilterOperator.Contains, this._sSearch),
            new Filter("shortDescription", FilterOperator.Contains, this._sSearch)
          ],
          and: false
        }));
      }

      this.byId("dashTable").getBinding("items").filter(aFilters);
    },

    onSearch: function (oEvent) {
      this._sSearch = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim();
      this._applyFilters();
    },

    /* ---------------------------------------------------------
     * Navigation
     * ------------------------------------------------------- */
    onTicketPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext();
      if (oCtx) {
        this.getOwnerComponent().getRouter().navTo("detail", { id: oCtx.getProperty("ID") });
      }
    },

    onCreateTicket: function () {
      this.getOwnerComponent().getRouter().navTo("create");
    },

    onGoList: function () {
      this.getOwnerComponent().getRouter().navTo("list");
    },

    // OData v4 delivers timestamps as ISO strings; format them for display.
    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
    }

  });
});