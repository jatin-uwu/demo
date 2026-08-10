sap.ui.define([
  "sap/ui/core/UIComponent"
], function (UIComponent) {
  "use strict";

  // Routes partitioned by persona — the single choke point for role-based
  // frontend routing. Every route match (including a manually typed hash)
  // is checked against this before the target view ever mounts, and the
  // redirect never adds a history entry, so Back can't step back into the
  // wrong persona's screen either. This is defense in depth only: the
  // actual authorization boundary is server-side (srv/handlers/*.js) — see
  // CURRENT_STATUS.md's "Role checks are server-side only" note. Hiding a
  // route here just means a disallowed persona never sees the screen in
  // the first place, not that the API would have let them through it.
  //
  //   Consultant   — a distinct, isolated identity (see xs-security.json —
  //                  its role-template carries no Agent/ServiceGroup
  //                  scope): only ever sees the Consultant routes.
  //   Support Team — (ServiceGroup/Admin) sees the shared End User routes
  //                  (ticket table, create/detail — they triage and assign
  //                  from there too) *plus* their own analytics/queue.
  //   End User     — sees only the shared routes; the Support Team's own
  //                  analytics/queue screens are off limits to them.
  var CONSULTANT_ROUTES = ["assigned", "assignedDetail"];
  var SUPPORT_ONLY_ROUTES = ["serviceGroupDashboard", "sgTickets"];
  var SHARED_ROUTES = ["dashboard", "analytics", "create", "detail"];

  return UIComponent.extend("itsm.ui.Component", {
    metadata: { manifest: "json" },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      var oRouter = this.getRouter();
      var that = this;

      this._fetchCurrentUser().then(function (oPersona) {
        that._bIsConsultant = oPersona.isConsultant;
        that._bIsSupport = oPersona.isSupport;
        that._guardRoutes(oRouter);
        oRouter.initialize();
        if (that._bIsSupport && !that._bIsConsultant) {
          that._applyRoleBasedLanding();
        }
      });
    },

    /**
     * Role-based default landing. Support Team users who open the app at
     * the default (End User) landing are sent to their own analytics
     * dashboard instead. Runs once, at startup, and only when the app
     * opened on the default route — so deep links and any later navigation
     * back to the ticket table (e.g. via "View Tickets") are never
     * hijacked. Reuses the persona already resolved in init() rather than
     * asking currentUser() a second time.
     *
     * The End User flow is untouched: their hash resolves normally and
     * this redirect never fires for them. Consultants never reach this
     * method at all (see init()) — their own landing is handled entirely
     * by _guardRoutes' sHome.
     */
    _applyRoleBasedLanding: function () {
      var oRouter = this.getRouter();
      // Only act on the default landing; leave every explicit route alone.
      if (oRouter.getHashChanger().getHash()) { return; }
      oRouter.navTo("serviceGroupDashboard");
    },

    /**
     * Resolved once at startup — role membership doesn't change mid-session,
     * so every route match for the rest of the session reuses this instead
     * of re-fetching it. isConsultant/isSupport come from the server-side
     * currentUser() function (derived from the authenticated identity, so a
     * client cannot forge them).
     */
    _fetchCurrentUser: function () {
      var oModel = this.getModel();
      var oAction = oModel.bindContext("/currentUser(...)");
      return oAction.execute().then(function () {
        var oCtx = oAction.getBoundContext();
        return {
          isConsultant: !!oCtx.getProperty("isConsultant"),
          isSupport: !!(oCtx.getProperty("isServiceGroup") || oCtx.getProperty("isAdmin"))
        };
      }).catch(function () {
        // Best-effort: if identity can't be resolved, fall back to the
        // least-privileged (End User) experience rather than blocking the
        // app entirely or over-granting access.
        return { isConsultant: false, isSupport: false };
      });
    },

    /**
     * Three-way route partition: a persona only ever sees its own routes
     * plus whatever SHARED_ROUTES it's entitled to. Consultant is fully
     * isolated (its own routes only); Support Team gets SHARED_ROUTES plus
     * its own SUPPORT_ONLY_ROUTES; a plain End User gets SHARED_ROUTES
     * only. Guarding is purely additive — a route not in any of these three
     * lists (there are none today) would be reachable by everyone, same as
     * before this partition existed.
     */
    _guardRoutes: function (oRouter) {
      var that = this;
      var aGuarded, sHome;

      if (this._bIsConsultant) {
        aGuarded = SUPPORT_ONLY_ROUTES.concat(SHARED_ROUTES);
        sHome = "assigned";
      } else if (this._bIsSupport) {
        aGuarded = CONSULTANT_ROUTES;
        sHome = "serviceGroupDashboard";
      } else {
        aGuarded = CONSULTANT_ROUTES.concat(SUPPORT_ONLY_ROUTES);
        sHome = "dashboard";
      }

      aGuarded.forEach(function (sRouteName) {
        var oRoute = oRouter.getRoute(sRouteName);
        if (!oRoute) { return; }
        oRoute.attachPatternMatched(function () {
          oRouter.navTo(sHome, {}, true /* no history entry */);
        });
      });
    }
  });
});
