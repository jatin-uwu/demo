using { itsm as db } from '../db/schema';
 
service IncidentService {
 
    @readonly
    entity Lookup as projection on db.LookupValue;
 
    entity Incident as projection on db.Incident;
 
    entity Attachment as projection on db.Attachment;
 
}