/** 把一份本地 .json 报告重新传一次（补传用）：走的是界面按钮同一条 uploadReport */
import { readFileSync } from 'node:fs';
import { uploadReport } from '../src/net/reports.ts';
import type { MatchReport } from '../src/core/report.ts';

const file = process.argv[2];
if (!file) { console.error('用法：upload-report.ts <report.json>'); process.exit(1); }
const report = JSON.parse(readFileSync(file, 'utf8')) as MatchReport;
const res = await uploadReport(report);
console.log(JSON.stringify(res, null, 2));
