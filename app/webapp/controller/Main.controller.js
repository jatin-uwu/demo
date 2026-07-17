sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";

  return Controller.extend("itsm.ui.controller.Main", {

    /* ---------------------------------------------------------
     * Lifecycle
     * ------------------------------------------------------- */
    onInit: function () {
      // Local model for pending attachments (before incident is saved)
      this.getView().setModel(new JSONModel({ list: [] }), "attachments");

      // Create a fresh transient Incident context bound to the form
      this._createDraftIncident();
    },

    /* ---------------------------------------------------------
     * Create a transient (pending) OData v4 context
     * The form binds against this context. On submitBatch the
     * record is POSTed to /Incident.
     * ------------------------------------------------------- */
    _createDraftIncident: function () {
      // Models propagate from the component; the view is not yet attached
      // to the control tree during onInit, so getView().getModel() is undefined here.
      var oModel = this.getOwnerComponent().getModel();
      var oListBinding = oModel.bindList("/Incident", null, [], [], {
        $$updateGroupId: "incidentGroup"
      });

      // create() returns a transient context — nothing sent to server yet
      this._oIncidentContext = oListBinding.create({
        status_ID: null,
        impact_ID: null,
        urgency_ID: null,
        priority_ID: null,
        category1_ID: null,
        category2_ID: null,
        category3_ID: null,
        category4_ID: null,
        solutionCategory_ID: null
      }, true /* bSkipRefresh */);

      // Bind the whole page to this transient context
      this.getView().setBindingContext(this._oIncidentContext);
    },

    /* ---------------------------------------------------------
     * SAVE — persists the incident as a draft (keeps user on page)
     * ------------------------------------------------------- */
    onSave: function () {
      var that = this;
      var oModel = this.getView().getModel();

      // Basic client-side check
      var oData = this._oIncidentContext.getObject();
      if (!oData.shortDescription) {
        MessageBox.warning("Short Description is required.");
        return;
      }

      // Send the batch to the server
      oModel.submitBatch("incidentGroup").then(function () {
        MessageToast.show("Incident saved");

        // After save the context is no longer transient — grab its key
        // and upload any pending attachments.
        return that._uploadPendingAttachments();
      }).then(function () {
        // Prepare a fresh draft for the next incident (optional)
        // that._createDraftIncident();
      }).catch(function (err) {
        MessageBox.error("Save failed: " + (err.message || err));
      });
    },

    /* ---------------------------------------------------------
     * SUBMIT — same as save but also validates required fields
     * ------------------------------------------------------- */
    onSubmit: function () {
      var oData = this._oIncidentContext.getObject();

      var aMissing = [];
      if (!oData.shortDescription)  aMissing.push("Short Description");
      if (!oData.impact_ID)         aMissing.push("Impact");
      if (!oData.urgency_ID)        aMissing.push("Urgency");
      if (!oData.priority_ID)       aMissing.push("Final Priority");
      if (!oData.description)       aMissing.push("Full Description");

      if (aMissing.length) {
        MessageBox.warning("Please fill in: " + aMissing.join(", "));
        return;
      }

      this.onSave();
    },

    /* ---------------------------------------------------------
     * File selection — queue locally (upload after incident save)
     * ------------------------------------------------------- */
    onFileSelected: function (oEvent) {
      var aFiles = oEvent.getParameter("files");
      if (!aFiles || !aFiles.length) { return; }

      var oAttModel = this.getView().getModel("attachments");
      var aList = oAttModel.getProperty("/list");

      Array.prototype.forEach.call(aFiles, function (file) {
        aList.push({
          fileName: file.name,
          originalName: file.name,
          mimeType: file.type,
          fileSize: file.size,
          _fileObject: file            // kept only in memory
        });
      });

      oAttModel.setProperty("/list", aList);
      MessageToast.show(aFiles.length + " file(s) queued");
    },

    /* ---------------------------------------------------------
     * After the incident is persisted, create an Attachment
     * record for each queued file (metadata only — matches your
     * schema which stores storagePath, not binary).
     *
     * If you later add a real upload endpoint, POST the binary
     * there first and store the returned URL in storagePath.
     * ------------------------------------------------------- */
    _uploadPendingAttachments: function () {
      var oAttModel = this.getView().getModel("attachments");
      var aList = oAttModel.getProperty("/list") || [];
      if (!aList.length) { return Promise.resolve(); }

      var sIncidentID = this._oIncidentContext.getProperty("ID");
      if (!sIncidentID) { return Promise.resolve(); }

      var oModel = this.getView().getModel();
      var oAttBinding = oModel.bindList("/Attachment", null, [], [], {
        $$updateGroupId: "incidentGroup"
      });

      aList.forEach(function (f) {
        oAttBinding.create({
          incident_ID: sIncidentID,
          fileName: f.fileName,
          originalName: f.originalName,
          mimeType: f.mimeType,
          fileSize: f.fileSize,
          storagePath: "/uploads/" + f.fileName  // placeholder
        });
      });

      return oModel.submitBatch("incidentGroup").then(function () {
        oAttModel.setProperty("/list", []);
        MessageToast.show("Attachments linked");
      });
    }

  });
});
