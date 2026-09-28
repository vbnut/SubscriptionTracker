# D365 Finance & Operations Custom Fields Guide

## Current Situation

After analyzing your D365 F&O environment, here's what we found:

### Available Contact Entities:
1. **ContactPersons** - 120 fields, but NO custom fields
2. **CDSContactPersonsV2** - 41 fields, but NO custom fields
3. **CDSContactPersons** - 39 fields, but NO custom fields
4. **ITSBNETContactCustomAttributesTables** - Custom attributes in EAV pattern (only stores business interest codes)

### Missing Custom Fields:
None of the contact entities have these required fields:
- ❌ `itsbnet_hubspotid` - HubSpot contact ID for tracking
- ❌ `itsbnet_contactnumber` - Contact number
- ❌ `itsbnet_businessinterest` - Business interest
- ❌ `itsbnet_contactfunction` - Contact function
- ❌ `itsbnet_leadsource` - Lead source
- ❌ `itsbnet_salesgroup` - Sales group
- ❌ `itsbnet_salesperson` - Sales person
- ❌ `itsbnet_salespersonemail` - Sales person email
- ❌ `itsbnet_companybu` - Company BU
- ❌ `itsbnet_activestatus` - Active status
- ❌ `CustomerAccount` - Link to customer
- ❌ `JobTitle` - Job title (standard field missing in CDS entities)

---

## Options for Adding Custom Fields to D365 F&O

### Option 1: Extend Contact Tables (RECOMMENDED for F&O)

This requires D365 F&O development access and deployment.

#### Step-by-Step Process:

1. **Prerequisites:**
   - Visual Studio with D365 F&O development tools
   - Access to your D365 F&O development environment
   - Knowledge of X++ and D365 F&O development

2. **Create Table Extension:**

   ```xml
   <!-- Create a new table extension in Visual Studio -->
   Project Name: ITSBNETContactExtensions
   Table: ContactPerson
   Extension Name: ITSBNETContactPerson.Extension
   ```

3. **Add Custom Fields:**

   In Visual Studio, add these fields to the ContactPerson table extension:

   | Field Name | Type | EDT/Extended Data Type |
   |------------|------|----------------------|
   | ITSBNETHubSpotId | String | String255 |
   | ITSBNETContactNumber | String | String60 |
   | ITSBNETBusinessInterest | Enum | Create custom enum |
   | ITSBNETContactFunction | Enum | Create custom enum |
   | ITSBNETLeadSource | Enum | Create custom enum |
   | ITSBNETSalesGroup | String | String60 |
   | ITSBNETSalesPerson | String | String60 |
   | ITSBNETSalesPersonEmail | String | Email |
   | ITSBNETCompanyBU | String | String60 |
   | ITSBNETActiveStatus | Enum | Create Yes/No enum |
   | ITSBNETCustomerAccount | String | CustAccount (EDT) |

4. **Create Data Entity Extension:**

   Extend the `ContactPersonEntity` or `CDSContactPersonsV2Entity` to expose the new fields in OData:

   ```xml
   Entity Name: ContactPersonEntity
   Extension Name: ITSBNETContactPersonEntity.Extension
   ```

   Map the new table fields to the data entity.

5. **Build and Deploy:**

   ```powershell
   # Build the solution in Visual Studio
   # Create deployable package
   # Deploy to UAT environment
   # Sync database
   ```

6. **Verify Fields:**

   After deployment, the fields should be available in the OData endpoint:
   ```
   https://your-d365.operations.dynamics.com/data/ContactPersons
   ```

#### Pros:
- ✅ Native F&O solution
- ✅ Fields appear directly on entity
- ✅ Full integration with F&O

#### Cons:
- ❌ Requires development environment
- ❌ Requires deployment (can take time)
- ❌ Requires X++ knowledge
- ❌ Slower iteration

---

### Option 2: Use D365 CRM for Contacts (STRONGLY RECOMMENDED)

Your environment already has Dynamics 365 CRM configured with custom fields!

#### Why This is Better:

1. **Custom fields already exist in CRM:**
   ```javascript
   // From your dynamics-operations.js
   'itsbnet_hubspotid': 'itsbnet_hubspotid',
   'itsbnet_contactfunction': 'itsbnet_contactfunction',
   'itsbnet_leadsource': 'itsbnet_leadsource',
   'itsbnet_businessinterest': 'itsbnet_businessinterest',
   ```

2. **CRM is designed for contact management**
3. **No development/deployment needed**
4. **Immediate changes**

#### To Use CRM Instead:

**Update your sync script to use D365 CRM:**

```javascript
// Change from:
const DynamicsFOOperations = require('./dynamics-fo-operations');

// To:
const DynamicsOperations = require('./dynamics-operations');

// Update constructor:
this.dynamics = new DynamicsOperations(
    process.env.DYNAMICS_URL,
    await getDynamicsToken() // You'll need to implement token generation
);
```

**CRM Endpoint:**
```
https://barnet-uat.sandbox.operations.dynamics.com/api/data/v9.2/contacts
```

---

### Option 3: Use Custom Attributes Table (EAV Pattern)

Use the existing `ITSBNETContactCustomAttributesTables` for custom data.

#### How It Works:

Currently stores only business interest codes. You could extend it to store other attributes:

```javascript
// Structure:
{
    ContactPersonId: "000407",
    ITSBNETAttributeCode: "HUBSPOT_ID", // or "SKIN CARE", "ALL", etc.
    dataAreaId: "s360"
}
```

#### Implementation:

1. Insert attribute records when creating contacts
2. Query attributes table when reading contacts
3. Join data in your application layer

#### Pros:
- ✅ No F&O development needed
- ✅ Flexible schema

#### Cons:
- ❌ Complex querying (need joins)
- ❌ Performance overhead
- ❌ No referential integrity
- ❌ Hard to maintain

---

## Recommended Approach

### **Use Dynamics 365 CRM for Contacts**

Based on your codebase analysis:

1. ✅ **CRM already has all custom fields** you need
2. ✅ Your `dynamics-operations.js` already supports it
3. ✅ CRM is the right tool for contact management
4. ✅ No deployment overhead
5. ✅ F&O is better suited for customers/accounts (which you're already doing)

### Architecture:

```
HubSpot
   ↓
   ├─→ Dynamics 365 CRM (Contacts)
   │   - Contact details
   │   - Custom fields (itsbnet_*)
   │   - Link to accounts via accountid
   │
   └─→ Dynamics 365 F&O (Customers/Accounts)
       - Customer accounts (CustomersV3)
       - Financial data
       - Account numbers
```

---

## Implementation Steps (Using CRM)

### 1. Create New Sync Script

Create `src/hubspot-to-d365crm-contact-sync.js` using CRM operations:

```javascript
const HubSpotOperations = require('./hubspot-operations');
const DynamicsOperations = require('./dynamics-operations');
const getDynamicsToken = require('../utils/get-dynamics-token');

class HubSpotToD365CRMContactSync {
    async sync() {
        // 1. Fetch HubSpot contacts
        // 2. Map to CRM format
        // 3. Create/Update in CRM contacts entity
        // 4. Link to accounts via accountid
    }
}
```

### 2. Field Mapping

Map HubSpot → D365 CRM:

| HubSpot | D365 CRM |
|---------|----------|
| firstname | firstname |
| lastname | lastname |
| email | emailaddress1 |
| phone | telephone1 |
| jobtitle | jobtitle |
| contactid | itsbnet_hubspotid |
| contact_function | itsbnet_contactfunction |
| business_interest | itsbnet_businessinterest |
| leadsource | itsbnet_leadsource |

### 3. Link to F&O Customers

CRM contacts can reference F&O customers through:
- Account number stored in CRM
- Integration/sync between CRM accounts and F&O customers

---

## Next Steps

**Choose your path:**

### Path A: Use CRM (Recommended)
1. I can help you create the CRM sync script
2. Update field mappings
3. Test with Isabella Peñaloza contact
4. Deploy

### Path B: Add Fields to F&O
1. Set up F&O development environment
2. Create table extensions
3. Build and deploy
4. Update OData entity
5. Test sync

**Which path would you like to pursue?**

---

## Additional Resources

- [Extend Dynamics 365 F&O Tables](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/extensibility/add-field-extension)
- [D365 F&O Data Entities](https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/data-entities/data-entities)
- [Dynamics 365 CRM Web API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview)
