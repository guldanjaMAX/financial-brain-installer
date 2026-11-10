// Exact reviewed templates over a complete tiny relational envelope. A SQL
// edit needs an explicit adapter review, rather than a successful empty read.
export const SQL_CONTRACTS = new Map([
  // Pending observations suppress only a live posted twin with provider linkage
  // in the same tenant and source account. Completed-read bytes are unchanged.
  ['c27e481664b7f00c82d93f2ad6ebb1dee85da861fc18beef01845dba793cdad1', 'pending'],
  // Pure-role disclosure query; existing lifecycle contracts remain authoritative.
  ['691457d16b102fb1d8d99304a957400f783e5d3e95e67820ef41eb9a61ed74fb', 'inventory'],
  // C3 restores only the entity-label projection while retaining merged lifecycle guards.
  ['b2e27b5a4ebd769c59a45bcc725fc16fc1edeae4304344dff97cf56b9710fcb8', 'inventory'],
  // Lifecycle projection preserves S7 admission; completed reads enforce opening and closing dates.
  ['1d26a6017bc13b2b6bbe6c5bc4d1b43c4f8e763c3c40985be0dcc683185df417', 'inventory'],
  ['70edb519f5008a4d644c9e1baf1871a4ca41baefcc27d2c3981e626c0a4b6d71', 'transactions'],
  ['3db04990951913cfcc75273fa1c136f3dcf822a73300d448561bcd68667af97e', 'pending'],
  // Exact C3 negative projection control retains status and all admission guards.
  ['6109850ec7cdc7cd772da1888ad8a728b353a1ca09805f19f0034c0c4b8588ba', 'inventory'],
  // Same bounded transaction mapping, restricted to pending observations.
  ['8b84eb88aa31d18c97b4cd0e59c721279b402a8ecadb1a5b001b46a4171151c7', 'pending'],
  // Combined inventory projects status without changing existing owner and sync guards.
  ['0bb49df42fddfeedcc2796fc9e3439370d3f8357e7df5533ee630a9265a6623a', 'inventory'],
  // Preserve owner labels and admission guards while projecting sync/backfill state.
  ['0239a5f64276273f4ed309067a6f6832060381e5dcfb9e5ffd4384e0f94fe4ff', 'inventory'],
  // Reviewed disclosure-lane inventory remains recognized by both replay adapters.
  ['f59e424db37962d07a19535fca9f16ee42d5a3375dfefd07ac4080542425238f', 'inventory'],
  // Head admission predicates plus the entity label; reviewed projection only.
  ['9835ead2939be8882776ae37a0b65b11ffd5bb758d575c727b56b7f3d7e08475', 'inventory'],
  ['0560a90893bdbca03eb46f39580b9d0e6fd87070fe7c3560a58d12de0a571b2e', 'inventory'],
  // Same bounded owner inventory plus the confirmed entity display label.
  // SQL remains byte-exact; no tenant, bind, join or coverage guard changes.
  ['3bd85475b3f1ef8da89e44ed0f7d798b3f3c8a471f11cd551db4e5654a1922b1', 'inventory'],
  // The merged inventory retains owner-reviewed account kinds and adds the
  // confirmed entity kind. No tenant, limit, join or admission guard changes.
  ['085a3cb746a3831a3f0a640f08a0ffbd57297d917c3e1dfe483d8d581d74efa6', 'inventory'],
  // Same bounded inventory, with confirmed entity type for business snapshots.
  ['8d1126285386dfebc08c6d886859e8ee4cd569a519b4f9349e01db85ef0367ba', 'inventory'],
  ['4854d478915c18d7ae5b6a21138d35925f4053a5c5bf0f5499f412a88dea0c17', 'inventory'],
  ['511315a8f707696def73f2bcdf1759704fa16b1f636dabc5c983a4fdc562f3a6', 'inventory'],
  ['75a8b53f9dd622790714fac513fd4d5f38797b9a7f7667bf5967b80891223c7d', 'transactions'],
  ['52e835bb7e812bb49c4b295f6bc663cc1a365d0fb13974d824997bf47fc45209', 'balances'],
  ['e29880643e5fdfd0101290335d6e28395a1858558d043ca18de061e2f8b97fcd', 'balances'],
  // SimpleFIN balance role and fenced observation cutoff retained from S2.
  ['9fd1565b305eed1ed63e8436e7474a597176ef1ae2ad1dbdc655f7830b758924', 'balances'],
]);
