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

    onCreateTicket: function () {
      this.getOwnerComponent().getRouter().navTo("create");
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
