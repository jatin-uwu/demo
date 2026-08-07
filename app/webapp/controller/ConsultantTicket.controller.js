sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, Filter, FilterOperator, Sorter, MessageToast, MessageBox) {
  "use strict";

  var STATUS_CLOSED = "CLOSED";

  return Controller.extend("itsm.ui.controller.ConsultantTicket", {

    /* ---------------------------------------------------------
     * Lifecycle
     * ------------------------------------------------------- */
    onInit: function () {
      this.getView().setModel(new JSONModel({}), "ui");
      this.getView().setModel(new JSONModel({ list: [] }), "attachments");

      this._mUserNames = {};
      this._mTeamNames = {};
      this._mTicketTypeName = {};
      this._loadLookupMaps();

      this.getOwnerComponent().getRouter()
        .getRoute("assignedDetail")
        .attachPatternMatched(this._onDetailMatched, this);
    },

    _loadLookupMaps: function () {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();

      oModel.bindList("/Users").requestContexts(0, 999).then(function (aCtx) {
        aCtx.forEach(function (c) { that._mUserNames[c.getProperty("userId")] = c.getProperty("name"); });
      }).catch(function () { /* best-effort */ });

      oModel.bindList("/SupportTeams").requestContexts(0, 999).then(function (aCtx) {
        aCtx.forEach(function (c) { that._mTeamNames[c.getProperty("teamCode")] = c.getProperty("name"); });
      }).catch(function () { /* best-effort */ });

      oModel.bindList("/LookupValues", null, [], [new Filter("lookupType", FilterOperator.EQ, "TICKETTYPE")])
        .requestContexts(0, 50).then(function (aCtx) {
          aCtx.forEach(function (c) { that._mTicketTypeName[c.getProperty("code")] = c.getProperty("name"); });
        }).catch(function () { /* best-effort */ });
    },

    formatUserName: function (sUserId) { return sUserId ? (this._mUserNames[sUserId] || sUserId) : ""; },
    formatTeamName: function (sCode) { return sCode ? (this._mTeamNames[sCode] || sCode) : ""; },
    formatTicketTypeName: function (sCode) { return sCode ? (this._mTicketTypeName[sCode] || sCode) : ""; },

    formatDateTime: function (sValue) {
      if (!sValue) { return ""; }
      var oDate = new Date(sValue);
      return isNaN(oDate.getTime()) ? "" : oDate.toLocaleString();
    },

    /* ---------------------------------------------------------
     * Route: assignedDetail — bind the ticket the URL asked for. If it
     * doesn't resolve (not assigned to this Consultant — see
     * srv/handlers/ticket.js onReadTicket, which scopes /Tickets to
     * messageProcessor = me), bounce back to the list rather than show a
     * broken page.
     * ------------------------------------------------------- */
    _onDetailMatched: function (oEvent) {
      var that = this;
      var sId = oEvent.getParameter("arguments").id;
      var oModel = this.getOwnerComponent().getModel();

      var oCtx = oModel.bindContext(
        "/Tickets(ticketID='" + sId + "')",
        null,
        { $$updateGroupId: "incidentGroup" }
      ).getBoundContext();

      this._oTicketContext = oCtx;
      this.getView().setBindingContext(oCtx);

      this.getView().getModel("ui").setData({
        ticketLabel: sId,
        subtitle: "Investigating assigned incident",
        formEditable: false,
        saveEnabled: false
      });

      oCtx.requestObject().then(function (oData) {
        if (!oData) { throw new Error("not found"); }
        var bEditable = oData.status !== STATUS_CLOSED;
        that.getView().getModel("ui").setData({
          ticketLabel: oData.ticketNumber || sId,
          subtitle: bEditable ? "Investigating assigned incident" : "Ticket closed — read only",
          formEditable: bEditable,
          saveEnabled: bEditable
        });
      }).catch(function () {
        MessageToast.show("That ticket isn't assigned to you.");
        that.getOwnerComponent().getRouter().navTo("assigned", {}, true);
      });

      this._loadAttachments(sId);
      this._scrollToTop();
    },

    _scrollToTop: function () {
      var oPage = this.byId("consultantPage");
      setTimeout(function () { oPage.scrollTo(0, 0, 0); }, 0);
    },

    /* ---------------------------------------------------------
     * Attachments — view/download only, same shape as Main.controller.js's
     * _loadAttachments but with no upload/remove affordance.
     * ------------------------------------------------------- */
    _loadAttachments: function (sId) {
      var that = this;
      var oModel = this.getOwnerComponent().getModel();
      var oBinding = oModel.bindList(
        "/Attachments",
        null,
        [new Sorter("createdAt", false)],
        [new Filter("ticket_ticketID", FilterOperator.EQ, sId)]
      );
      var sServiceUrl = oModel.getServiceUrl().replace(/\/$/, "");

      oBinding.requestContexts(0, 200).then(function (aContexts) {
        var aList = aContexts.map(function (oCtx) {
          var oRow = oCtx.getObject();
          return {
            ID: oRow.ID,
            fileName: oRow.fileName,
            uploadedBy: oRow.createdBy,
            uploadedOn: that.formatDateTime(oRow.createdAt),
            contentUrl: sServiceUrl + "/Attachments(" + oRow.ID + ")/content"
          };
        });
        that.getView().getModel("attachments").setProperty("/list", aList);
      }).catch(function () { /* supplementary — a failed load shouldn't block the page */ });
    },

    /* ---------------------------------------------------------
     * Tabs are in-page navigation — same scroll-to-section pattern as
     * Main.controller.js.
     * ------------------------------------------------------- */
    onTabSelect: function (oEvent) {
      var mSections = {
        info: "secInfo", general: "secGeneral", incident: "secIncident",
        technical: "secTechnical", sla: "secSla", sap: "secSap",
        work: "secWork", scheduled: "secScheduled"
      };
      var oSection = this.byId(mSections[oEvent.getParameter("key")]);
      if (oSection) {
        this.byId("consultantPage").scrollToElement(oSection.getDomRef(), 400);
      }
    },

    /* ---------------------------------------------------------
     * Navigation — Back always returns to Assigned Tickets. There's
     * nowhere else inside the Consultant module for it to go, and it must
     * never fall through to the shared End User / Service Group dashboard.
     * ------------------------------------------------------- */
    onBack: function () {
      this.getOwnerComponent().getRouter().navTo("assigned");
    },

    /* ---------------------------------------------------------
     * SAVE — a plain deep update (Status/Priority/technical fields plus
     * any staged comment/SAP note/scheduled action) via the same
     * submitBatch pattern Main.controller.js uses. No draft/submit/delete
     * branching here — a Consultant only ever edits a ticket that already
     * exists and is already active.
     * ------------------------------------------------------- */
    onSave: function () {
      if (this._bSaving) { return; }
      this._bSaving = true;
      this.getView().getModel("ui").setProperty("/saveEnabled", false);

      var that = this;
      var oModel = this.getView().getModel();

      function releaseSaveGuard() {
        that._bSaving = false;
        var bEditable = that.getView().getModel("ui").getProperty("/formEditable");
        that.getView().getModel("ui").setProperty("/saveEnabled", bEditable);
      }

      oModel.submitBatch("incidentGroup").then(function () {
        var sNumber = that._oTicketContext.getProperty("ticketNumber") || that.getView().getModel("ui").getProperty("/ticketLabel");
        MessageToast.show("Ticket " + sNumber + " updated.");

        var sStatus = that._oTicketContext.getProperty("status");
        var bEditable = sStatus !== STATUS_CLOSED;
        that.getView().getModel("ui").setProperty("/formEditable", bEditable);
        that.getView().getModel("ui").setProperty("/subtitle",
          bEditable ? "Investigating assigned incident" : "Ticket closed — read only");

        releaseSaveGuard();
      }).catch(function (err) {
        MessageBox.error("Save failed: " + (err.message || err));
        releaseSaveGuard();
      });
    },

    /* ---------------------------------------------------------
     * Comments — staged on the same list binding the view already uses to
     * display them (this.byId(...).getBinding("items")), so the new row
     * appears immediately and is flushed to the server on the next Save,
     * same as every other pending change on this page. Author is stamped
     * server-side (srv/handlers/ticket.js onUpdateTicket).
     * ------------------------------------------------------- */
    onAddComment: function () {
      var oArea = this.byId("newCommentArea");
      var sText = (oArea.getValue() || "").trim();
      if (!sText) { return; }

      this.byId("commentsList").getBinding("items").create({ comment: sText });
      oArea.setValue("");
    },

    /* ---------------------------------------------------------
     * SAP Notes
     * ------------------------------------------------------- */
    onAddSapNote: function () {
      this.byId("sapNoteNumberInput").setValue("");
      this.byId("sapNoteDescriptionInput").setValue("");
      this.byId("sapNoteComponentSelect").setSelectedKey("");
      this.byId("sapNoteStatusInput").setValue("");
      this.byId("addSapNoteDialog").open();
    },

    onConfirmAddSapNote: function () {
      var sNumber = (this.byId("sapNoteNumberInput").getValue() || "").trim();
      if (!sNumber) {
        MessageToast.show("Enter a SAP Note number.");
        return;
      }

      this.byId("sapNotesTable").getBinding("items").create({
        sapNoteNumber: sNumber,
        description: this.byId("sapNoteDescriptionInput").getValue(),
        component: this.byId("sapNoteComponentSelect").getSelectedKey(),
        status: this.byId("sapNoteStatusInput").getValue()
      });

      this.byId("addSapNoteDialog").close();
    },

    onCancelAddSapNote: function () {
      this.byId("addSapNoteDialog").close();
    },

    /* ---------------------------------------------------------
     * Scheduled Actions
     * ------------------------------------------------------- */
    onAddScheduledAction: function () {
      this.byId("actionDefinitionInput").setValue("");
      this.byId("processingTypeInput").setValue("");
      this.byId("actionStatusInput").setValue("");
      this.byId("scheduledAtPicker").setValue("");
      this.byId("executableCheckBox").setSelected(false);
      this.byId("addScheduledActionDialog").open();
    },

    onConfirmAddScheduledAction: function () {
      var sAction = (this.byId("actionDefinitionInput").getValue() || "").trim();
      if (!sAction) {
        MessageToast.show("Enter an action definition.");
        return;
      }

      var oDate = this.byId("scheduledAtPicker").getDateValue();

      this.byId("scheduledActionsTable").getBinding("items").create({
        actionDefinition: sAction,
        processingType: this.byId("processingTypeInput").getValue(),
        status: this.byId("actionStatusInput").getValue(),
        executable: this.byId("executableCheckBox").getSelected(),
        scheduledAt: oDate ? oDate.toISOString() : null
      });

      this.byId("addScheduledActionDialog").close();
    },

    onCancelAddScheduledAction: function () {
      this.byId("addScheduledActionDialog").close();
    }

  });
});
