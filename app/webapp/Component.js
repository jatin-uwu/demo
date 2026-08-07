sap.ui.define([
  "sap/ui/core/UIComponent"
], function (UIComponent) {
  "use strict";

  return UIComponent.extend("itsm.ui.Component", {
    metadata: { manifest: "json" },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      this.getRouter().initialize();
      this._applyRoleBasedLanding();
    },

    /**
     * Role-based default landing. Service Group / Admin users who open the
     * app at the default (End User) landing are sent to their own analytics
     * dashboard instead. Runs once, at startup, and only when the app opened
     * on the default route — so deep links and any later navigation back to
     * the ticket table (e.g. via "View Tickets") are never hijacked.
     *
     * The End User (Agent) flow is untouched: their hash resolves normally
     * and this redirect never fires for them.
     */
    _applyRoleBasedLanding: function () {
      var oRouter = this.getRouter();
      var oModel = this.getModel();
      if (!oModel) { return; }

      // Only act on the default landing; leave every explicit route alone.
      if (oRouter.getHashChanger().getHash()) { return; }

      var oCtx = oModel.bindContext("/currentUser(...)");
      oCtx.execute().then(function () {
        var oUser = oCtx.getBoundContext();
        var bServiceGroup = !!(oUser.getProperty("isServiceGroup") || oUser.getProperty("isAdmin"));
        // Still on the default landing when the role came back? Send them on.
        if (bServiceGroup && !oRouter.getHashChanger().getHash()) {
          oRouter.navTo("serviceGroupDashboard");
        }
      }).catch(function () { /* best-effort — fall back to the default landing */ });
    }
  });
});
