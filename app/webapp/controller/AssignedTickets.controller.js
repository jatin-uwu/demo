sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter"
], function (Controller, JSONModel, Filter, FilterOperator, Sorter) {
  "use strict";

  return Controller.extend("itsm.ui.controller.AssignedTickets", {

    /* ---------------------------------------------------------
     * Lifecycle. The table itself needs no client-side "mine only" filter —
     * the backend already scopes /Tickets to messageProcessor = me for a
     * Consultant (see srv/handlers/ticket.js onReadTicket), so this
     * controller only has to handle the Status/Priority/search refinements
     * on top of that.
     * ------------------------------------------------------- */
    onInit: function () {
      this._mStatusName = {};
      this._mPriorityName = {};
      this._mUserNames = {};
      this._mTeamNames = {};
      this._loadLookupMaps();
      this._loadFilterOptions();

      this.getOwnerComponent().getRouter()
        .getRoute("assigned")
        .attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      // Re-entering this page (e.g. Back from a ticket just saved) should
      // show the latest state, not a stale cached list.
      var oBinding = this.byId("assignedTable").getBinding("items");
      if (oBinding) { oBinding.refresh(); }
    },

    /* ---------------------------------------------------------
     * code -> name lookups for the table's plain-string columns. Same
     * best-effort pattern as Dashboard.controller.js.
     * ------------------------------------------------------- */
    _loadLookupMaps: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();

      function loadType(sType, oTarget) {
        var oBinding = oModel.bindList("/LookupValues", null, [], [
          new Filter("lookupType", FilterOperator.EQ, sType)
        ]);
        return oBinding.requestContexts(0, 999).then(function (aCtx) {
          aCtx.forEach(function (c) { oTarget[c.getProperty("code")] = c.getProperty("name"); });
        });
      }

      Promise.all([
        loadType("STATUS", this._mStatusName),
        loadType("PRIORITY", this._mPriorityName)
      ]).catch(function () { /* best-effort */ });

      oModel.bindList("/Users").requestContexts(0, 999).then(function (aCtx) {
        aCtx.forEach(function (c) { that._mUserNames[c.getProperty("userId")] = c.getProperty("name"); });
      }).catch(function () { /* best-effort */ });

      oModel.bindList("/SupportTeams").requestContexts(0, 999).then(function (aCtx) {
        aCtx.forEach(function (c) { that._mTeamNames[c.getProperty("teamCode")] = c.getProperty("name"); });
      }).catch(function () { /* best-effort */ });
    },

    formatStatusName: function (sCode) { return this._mStatusName[sCode] || sCode || ""; },
    formatPriorityName: function (sCode) { return this._mPriorityName[sCode] || sCode || ""; },
    formatUserName: function (sUserId) { return sUserId ? (this._mUserNames[sUserId] || sUserId) : ""; },
    formatTeamName: function (sCode) { return sCode ? (this._mTeamNames[sCode] || sCode) : ""; },

    /* ---------------------------------------------------------
     * Status/Priority filter dropdowns — same "options from master data
     * plus a leading All entry" pattern as Dashboard.controller.js's
     * _loadFilterOptions, trimmed to just the two filters this page offers.
     * ------------------------------------------------------- */
    _loadFilterOptions: function () {
      var oModel = this.getOwnerComponent().getModel();

      function load(sType, sAllLabel) {
        var oBinding = oModel.bindList("/LookupValues", null, [new Sorter("sequence")], [
          new Filter("lookupType", FilterOperator.EQ, sType)
        ]);
        return oBinding.requestContexts(0, 50).then(function (aCtx) {
          var aItems = aCtx.map(function (c) {
            return { code: c.getProperty("code"), name: c.getProperty("name") };
          });
          aItems.unshift({ code: "", name: sAllLabel });
          return aItems;
        });
      }

      var that = this;
      Promise.all([
        load("STATUS", "All Statuses"),
        load("PRIORITY", "All Priorities")
      ]).then(function (aRes) {
        that.getView().setModel(new JSONModel({ statuses: aRes[0], priorities: aRes[1] }), "filters");
      });
    },

    onFilterChange: function () {
      this._applyFilters();
    },

    onSearch: function (oEvent) {
      this._sSearch = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim();
      this._applyFilters();
    },

    onResetFilters: function () {
      this.byId("assignedStatusFilter").setSelectedKey("");
      this.byId("assignedPriorityFilter").setSelectedKey("");
      this._sSearch = "";
      this._applyFilters();
    },

    _applyFilters: function () {
      var aFilters = [];

      var sStatus = this.byId("assignedStatusFilter").getSelectedKey();
      if (sStatus) { aFilters.push(new Filter("status", FilterOperator.EQ, sStatus)); }

      var sPriority = this.byId("assignedPriorityFilter").getSelectedKey();
      if (sPriority) { aFilters.push(new Filter("priority", FilterOperator.EQ, sPriority)); }

      if (this._sSearch) {
        aFilters.push(new Filter({
          filters: [
            new Filter("ticketNumber", FilterOperator.Contains, this._sSearch),
            new Filter("shortDescription", FilterOperator.Contains, this._sSearch)
          ],
          and: false
        }));
      }

      this.byId("assignedTable").getBinding("items").filter(aFilters);
    },

    /* ---------------------------------------------------------
     * Navigation — the only place a row press can go is the Consultant's
     * own working form, never the shared Main detail view.
     * ------------------------------------------------------- */
    onTicketPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext();
      if (oCtx) {
        this.getOwnerComponent().getRouter().navTo("assignedDetail", { id: oCtx.getProperty("ticketID") });
      }
    },

    onGoAssigned: function () {
      this.getOwnerComponent().getRouter().navTo("assigned");
    },

    // OData v4 delivers timestamps as ISO strings; format them for display.
    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
    },

    // Same status/priority -> ValueState mapping as Dashboard.controller.js,
    // so the badges read identically across both ticket lists.
    formatStatusState: function (sCode) {
      switch (sCode) {
        case "NEW": return "Information";
        case "IN_PROCESS": return "Warning";
        case "CUSTOMER_ACTION": return "Error";
        case "SOLUTION_PROPOSED": return "Warning";
        case "CONFIRMED": return "Success";
        case "CLOSED": return "Success";
        default: return "None";
      }
    },

    formatPriorityState: function (sCode) {
      switch (sCode) {
        case "P1": return "Error";
        case "P2": return "Warning";
        case "P3": return "Information";
        default: return "None";
      }
    }

  });
});
