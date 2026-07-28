sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator"
], function (Controller, Filter, FilterOperator) {
  "use strict";

  return Controller.extend("itsm.ui.controller.TicketList", {

    onInit: function () {
      // Refresh the list every time we land here so a just-created ticket shows.
      this.getOwnerComponent().getRouter()
        .getRoute("list")
        .attachPatternMatched(this._onListMatched, this);
    },

    _onListMatched: function () {
      var oBinding = this.byId("ticketTable").getBinding("items");
      if (oBinding) {
        oBinding.refresh();
      }
    },

    // OData v4 delivers timestamps as ISO strings; format them for display.
    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
    },

    // Status -> sap.ui.core.ValueState, so open/blocked tickets stand out
    // (Customer Action in red) and closed ones read as done (green).
    formatStatusState: function (sName) {
      switch (sName) {
        case "New": return "Information";
        case "In Process": return "Warning";
        case "Customer Action": return "Error";
        case "Solution Proposed": return "Warning";
        case "Confirmed": return "Success";
        case "Closed": return "Success";
        default: return "None";
      }
    },

    // Priority -> sap.ui.core.ValueState, so P1/P2 (needs urgent attention)
    // pop in red/amber against the rest of the row.
    formatPriorityState: function (sName) {
      if (!sName) { return "None"; }
      if (sName.indexOf("P1") === 0) { return "Error"; }
      if (sName.indexOf("P2") === 0) { return "Warning"; }
      if (sName.indexOf("P3") === 0) { return "Information"; }
      return "None";
    },

    onCreateTicket: function () {
      this.getOwnerComponent().getRouter().navTo("create");
    },

    onGoDashboard: function () {
      this.getOwnerComponent().getRouter().navTo("dashboard");
    },

    onTicketPress: function (oEvent) {
      // Works whether the event comes from the ColumnListItem (press) or the
      // Table (itemPress).
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext();
      if (oCtx) {
        this.getOwnerComponent().getRouter().navTo("detail", { id: oCtx.getProperty("ID") });
      }
    },

    onSearch: function (oEvent) {
      var sQuery = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim();
      var aFilters = [];
      if (sQuery) {
        aFilters.push(new Filter({
          filters: [
            new Filter("incidentNumber", FilterOperator.Contains, sQuery),
            new Filter("shortDescription", FilterOperator.Contains, sQuery)
          ],
          and: false
        }));
      }
      this.byId("ticketTable").getBinding("items").filter(aFilters);
    }

  });
});