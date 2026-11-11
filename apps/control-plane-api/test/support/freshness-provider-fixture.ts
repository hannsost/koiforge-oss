// Scripted test-provider response; never a preinstalled production module.
export const validCode = String.raw`
const { rows, rule } = JSON.parse(content);
function instant(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  const [y,m,d,h,min,s] = match.slice(1,7).map(Number);
  const leap = y%400===0 || y%4===0 && y%100!==0;
  const days = [31,leap?29:28,31,30,31,30,31,31,30,31,30,31][m-1];
  if (!days || d<1 || d>days || h>23 || min>59 || s>59) return NaN;
  const zone=match[7];
  if (zone!=='Z' && (+zone.slice(1,3)>23 || +zone.slice(4)>59)) return NaN;
  return Date.parse(value);
}
if (!rule || !Number.isSafeInteger(rule.maxAgeSeconds) || rule.maxAgeSeconds<=0 ||
    rule.maxAgeSeconds>315360000 || !Number.isFinite(instant(rule.asOf)) ||
    rule.timezone!=='explicit-offset' || rule.timestampMeaning!=='source_updated_at') throw Error('rule');
const seen = new Set();
result = rows.map(row => {
  if(typeof row.sourceId!=='string' || !row.sourceId.trim() || seen.has(row.sourceId)) throw Error('id');
  seen.add(row.sourceId);
  let ageSeconds=null,status='unassessable',reason;
  if(row.sourceUpdatedAt==null || row.sourceUpdatedAt.trim()==='') reason='missing_timestamp';
  else if(!Number.isFinite(instant(row.sourceUpdatedAt))) reason='invalid_timestamp';
  else {
    const age=(instant(rule.asOf)-instant(row.sourceUpdatedAt))/1000;
    if(age<0) reason='future_timestamp';
    else { ageSeconds=age; status=age<=rule.maxAgeSeconds?'current':'stale'; reason=status==='current'?'within_interval':'interval_exceeded'; }
  }
  return {sourceId:row.sourceId,sourceUpdatedAt:row.sourceUpdatedAt,status,ageSeconds,reason};
});`;
