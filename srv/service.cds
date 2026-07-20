using { itsm as db } from '../db/schema';
 
service IncidentService {
 
    @readonly
    entity Lookup as projection on db.LookupValue;
 
    entity Incident as projection on db.Incident;
 
    entity Attachment as projection on db.Attachment;

    // Preview of the next incident number, for read-only display on the form.
    // The authoritative number is still assigned on the backend at CREATE.
    function nextIncidentNumber() returns String;

}