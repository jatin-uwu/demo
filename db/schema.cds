 namespace itsm;
 
using { cuid, managed } from '@sap/cds/common';
 
/*=========================================
    Generic Lookup Table
=========================================*/
 
entity LookupValue : cuid, managed {
 
    lookupType      : String(50);     // STATUS, PRIORITY, IMPACT, URGENCY, CATEGORY1...
    code            : String(50);
    name            : String(100);
    description     : String(255);
 
    parent          : Association to LookupValue;
 
    sequence        : Integer;
    isDefault       : Boolean default false;
    isActive        : Boolean default true;
}
 
 
/*=========================================
    Incident
=========================================*/
 
entity Incident : cuid, managed {
 
    // General Data
    incidentNumber      : String(30);
 
    userId              : String(50);         // or Association to User
    reportedBy          : String(100);        // or Association to User
    supportTeam         : String(100);        // or Association to Team
    messageProcessor    : String(100);        // or Association to User
 
    shortDescription    : String(255);
    description         : LargeString;
 
    // Categories
    category1           : Association to LookupValue;
    category2           : Association to LookupValue;
    category3           : Association to LookupValue;
    category4           : Association to LookupValue;
    solutionCategory    : Association to LookupValue;
 
    // Processing Data
    status              : Association to LookupValue;
    impact              : Association to LookupValue;
    urgency             : Association to LookupValue;
    priority            : Association to LookupValue;
 
    // Dates
    createdOn           : Timestamp;
    firstResponseOn     : Timestamp;
    completedOn         : Timestamp;
}
 
 
/*=========================================
    Attachments
=========================================*/
 
entity Attachment : cuid, managed {
 
    incident        : Association to Incident;
 
    fileName        : String(255);
    originalName    : String(255);
    mimeType        : String(100);
    fileSize        : Integer;
    storagePath     : String(500);
}