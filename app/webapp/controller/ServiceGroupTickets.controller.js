sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, Filter, FilterOperator, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("itsm.ui.controller.ServiceGroupTickets", {

    onInit: function () {
      // code -> display name maps for the Status / Priority / Assigned-To columns
      this._mStatusName = {};
      this._mPriorityName = {};
      this._mUserName = {};

      this.getOwnerComponent().getRouter()
        .getRoute("sgTickets")
        .attachPatternMatched(this._onMatched, this);
    },

    /* ---------------------------------------------------------
     * ServiceGroup-only screen. isServiceGroup/isAdmin comes from the
     * server-side currentUser() (derived from the authenticated identity,
     * so a client cannot forge it). Anyone else is bounced to the End User
     * dashboard, exactly like the analytics guard.
     * ------------------------------------------------------- */
    _onMatched: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oCtx = oModel.bindContext("/currentUser(...)");
      oCtx.execute().then(function () {
        var oUser = oCtx.getBoundContext();
        var bAllowed = !!(oUser.getProperty("isServiceGroup") || oUser.getProperty("isAdmin"));
        if (!bAllowed) {
          MessageToast.show("Service Group Tickets is available to the Service Group only.");
          that.getOwnerComponent().getRouter().navTo("dashboard");
          return;
        }
        // Only load display data once the role is confirmed — keeps the
        // authorization request uncontended (so the guard resolves fast) and
        // avoids fetching lookup data for a user who is about to be bounced.
        that._loadLookupMaps();
        var oBinding = that.byId("sgTicketTable").getBinding("items");
        if (oBinding) { oBinding.refresh(); }
      }).catch(function () {
        // Could not confirm the role — fail closed rather than leak the screen.
        that.getOwnerComponent().getRouter().navTo("dashboard");
      });
    },

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

      var oUserB = oModel.bindList("/Users", null, [], []);
      var pUsers = oUserB.requestContexts(0, 999).then(function (aCtx) {
        aCtx.forEach(function (c) { that._mUserName[c.getProperty("userId")] = c.getProperty("name"); });
      });

      Promise.all([
        loadType("STATUS", that._mStatusName),
        loadType("PRIORITY", that._mPriorityName),
        pUsers
      ]).catch(function () { /* best-effort — columns fall back to raw codes */ });
    },

    /* ---------------------------------------------------------
     * Navigation
     * ------------------------------------------------------- */
    onBack: function () {
      this.getOwnerComponent().getRouter().navTo("serviceGroupDashboard");
    },

    onCreateTicket: function () {
      this.getOwnerComponent().getRouter().navTo("create");
    },

    onTicketPress: function (oEvent) {
      var oItem = oEvent.getParameter("listItem") || oEvent.getSource();
      var oCtx = oItem.getBindingContext();
      if (oCtx) {
        this.getOwnerComponent().getRouter().navTo("detail", { id: oCtx.getProperty("ticketID") });
      }
    },

    /* ---------------------------------------------------------
     * Bulk assign — ServiceGroup only, backed by the assignTickets() action
     * in srv/service.cds (which itself carries @requires: 'ServiceGroup', so
     * the server enforces it too). Pick an engineer and/or a support team for
     * the checked tickets.
     * ------------------------------------------------------- */
    onBulkAssign: function () {
      this._aAssignTicketIds = this.byId("sgTicketTable").getSelectedContexts()
        .map(function (oCtx) { return oCtx.getProperty("ticketID"); });

      if (!this._aAssignTicketIds.length) {
        MessageToast.show("Select at least one ticket to assign.");
        return;
      }

      this.byId("assignProcessorSelect").setSelectedKey("");
      this.byId("assignTeamSelect").setSelectedKey("");
      this.byId("assignDialog").open();
    },

    onConfirmAssign: function () {
      var that = this;
      var sProcessor = this.byId("assignProcessorSelect").getSelectedKey() || null;
      var sTeam = this.byId("assignTeamSelect").getSelectedKey() || null;

      if (!sProcessor && !sTeam) {
        MessageToast.show("Choose an engineer, a support team, or both.");
        return;
      }

      var oModel = this.getOwnerComponent().getModel();
      var oAction = oModel.bindContext("/assignTickets(...)");
      oAction.setParameter("tickets", this._aAssignTicketIds);
      oAction.setParameter("messageProcessor", sProcessor);
      oAction.setParameter("supportTeam", sTeam);

      oAction.execute().then(function () {
        var iChanged = oAction.getBoundContext().getValue();
        that.byId("assignDialog").close();
        MessageToast.show(iChanged + " ticket(s) updated.");
        that.byId("sgTicketTable").removeSelections(true);
        var oBinding = that.byId("sgTicketTable").getBinding("items");
        if (oBinding) { oBinding.refresh(); }
      }).catch(function (err) {
        MessageBox.error("Assign failed: " + (err.message || err));
      });
    },

    onCancelAssign: function () {
      this.byId("assignDialog").close();
    },

    onSearch: function (oEvent) {
      var sQuery = (oEvent.getParameter("query") || oEvent.getParameter("newValue") || "").trim();
      var aFilters = [];
      if (sQuery) {
        aFilters.push(new Filter({
          filters: [
            new Filter("ticketNumber", FilterOperator.Contains, sQuery),
            new Filter("shortDescription", FilterOperator.Contains, sQuery)
          ],
          and: false
        }));
      }
      this.byId("sgTicketTable").getBinding("items").filter(aFilters);
    },

    /* ---------------------------------------------------------
     * Formatters — same mapping the dashboard/analytics tables use, so the
     * columns render identically.
     * ------------------------------------------------------- */
    formatStatusName: function (sCode) { return this._mStatusName[sCode] || sCode || ""; },
    formatPriorityName: function (sCode) { return this._mPriorityName[sCode] || sCode || ""; },
    formatUserName: function (sUserId) { return this._mUserName[sUserId] || sUserId || "Unassigned"; },

    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
    },

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
