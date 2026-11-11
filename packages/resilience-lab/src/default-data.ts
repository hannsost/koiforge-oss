export function baseOrderRows() {
  return [
    { poNumber: 'PO-1001', supplierId: 'SUP-100', supplierName: 'Acme Components', status: 'approved', value: 18500, createdAt: '2026-03-27T09:15:00Z' },
    { poNumber: 'PO-1002', supplierId: 'SUP-200', supplierName: 'Nordic Steel', status: 'pending', value: 9200, createdAt: '2026-03-28T11:20:00Z' },
    { poNumber: 'PO-1003', supplierId: 'SUP-100', supplierName: 'Acme Components', status: 'shipped', value: 44200, createdAt: '2026-03-29T15:45:00Z' },
    { poNumber: 'PO-1004', supplierId: 'SUP-300', supplierName: 'Pacific Circuits', status: 'delayed', value: 13800, createdAt: '2026-03-30T08:10:00Z' },
    { poNumber: 'PO-1005', supplierId: 'SUP-200', supplierName: 'Nordic Steel', status: 'approved', value: 27600, createdAt: '2026-03-31T13:30:00Z' },
    { poNumber: 'PO-1006', supplierId: 'SUP-600', supplierName: 'Blue Harbor Motors', status: 'approved', value: 12900, createdAt: '2026-03-31T16:05:00Z' },
    { poNumber: 'PO-1007', supplierId: 'SUP-700', supplierName: 'Helios Metals', status: 'pending', value: 36100, createdAt: '2026-04-01T08:45:00Z' },
    { poNumber: 'PO-1008', supplierId: 'SUP-200', supplierName: 'Nordic Steel', status: 'delayed', value: 25400, createdAt: '2026-04-01T09:20:00Z' },
    { poNumber: 'PO-1009', supplierId: 'SUP-500', supplierName: 'River Plastics', status: 'review', value: 47200, createdAt: '2026-04-01T10:15:00Z' },
    { poNumber: 'PO-1010', supplierId: 'SUP-900', supplierName: 'Zenith Parts', status: 'pending', value: 58800, createdAt: '2026-04-01T10:45:00Z' },
    { poNumber: 'PO-1011', supplierId: 'SUP-950', supplierName: 'Silverline Sensors', status: 'approved', value: 21400, createdAt: '2026-04-01T11:05:00Z' },
    { poNumber: 'PO-1012', supplierId: 'SUP-700', supplierName: 'Helios Metals', status: 'shipped', value: 40750, createdAt: '2026-04-01T11:40:00Z' }
  ];
}

export function baseShipmentRows() {
  return [
    { shipmentId: 'SHP-501', eventType: 'created', message_timestamp: '2026-03-30T10:00:00Z', payload: '{"poNumber":"PO-1003"}' },
    { shipmentId: 'SHP-501', eventType: 'departed', message_timestamp: '2026-03-31T06:15:00Z', payload: '{"warehouse":"BER"}' },
    { shipmentId: 'SHP-601', eventType: 'delay-alert', message_timestamp: '2026-04-01T07:40:00Z', payload: '{"poNumber":"PO-1004"}' },
    { shipmentId: 'SHP-777', eventType: 'delivered', message_timestamp: '2026-04-01T12:05:00Z', payload: '{"poNumber":"PO-1001"}' },
    { shipmentId: 'SHP-801', eventType: 'created', message_timestamp: '2026-04-01T12:20:00Z', payload: '{"poNumber":"PO-1008"}' },
    { shipmentId: 'SHP-801', eventType: 'delay-alert', message_timestamp: '2026-04-01T15:45:00Z', payload: '{"poNumber":"PO-1008"}' },
    { shipmentId: 'SHP-901', eventType: 'created', message_timestamp: '2026-04-01T13:10:00Z', payload: '{"poNumber":"PO-1009"}' },
    { shipmentId: 'SHP-1001', eventType: 'created', message_timestamp: '2026-04-01T14:10:00Z', payload: '{"poNumber":"PO-1010"}' },
    { shipmentId: 'SHP-1001', eventType: 'customs-hold', message_timestamp: '2026-04-01T18:20:00Z', payload: '{"poNumber":"PO-1010"}' },
    { shipmentId: 'SHP-1102', eventType: 'delivered', message_timestamp: '2026-04-02T07:15:00Z', payload: '{"poNumber":"PO-1012"}' }
  ];
}
