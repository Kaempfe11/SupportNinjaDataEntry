// SKDLA Workflow Engine — Vercel Serverless Function
// Runs triage (doctor/office matching) and QC validation (ABS comparison + teeth check)
// Called by: Vercel Cron (every 5 min) OR manual "Run Engine" button from app

const { createClient } = require('@supabase/supabase-js');

// ── Team IDs ──
const TEAM_IDS = {
  support_ninja: '608b3e0e-649b-460a-a2f6-6f4e08501ee0',
  level_2_oc:    '43d0ad5c-7f47-4a73-b8e7-6f4e08501ee0',
  onboarding:    '3907ff2e-7f47-4a73-b8e7-6f4e08501ee0',
  aox:           'b33c1a88-7f47-4a73-b8e7-6f4e08501ee0',
  removables:    '51e631c8-7f47-4a73-b8e7-6f4e08501ee0'
};

// ── Helpers ──
function normalize(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function tokenize(s) {
  return normalize(s).split(' ').filter(Boolean);
}

function jaccard(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 0;
  const inter = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return inter / union;
}

// ── Load engine settings ──
async function loadSettings(supabase) {
  const { data } = await supabase.from('workflow_settings')
    .select('key, value')
    .in('key', ['engine_onboarding_auto_route', 'engine_l2_auto_escalate']);
  const settings = {};
  if (data) data.forEach(s => { settings[s.key] = s.value === 'true'; });
  return settings;
}

// ── Load team name→id map ──
async function loadTeams(supabase) {
  const { data } = await supabase.from('workflow_teams').select('id, name');
  const map = {};
  if (data) data.forEach(t => { map[t.name] = t.id; });
  return map;
}

// ═══════════════════════════════════════════════════════
// TRIAGE ENGINE — doctor/office lookup against Accounts
// ═══════════════════════════════════════════════════════
async function runTriage(supabase, caseId, settings, teams) {
  const { data: c, error } = await supabase.from('workflow_cases')
    .select('*').eq('id', caseId).single();
  if (error || !c) return null;

  const autoOnboard = settings.engine_onboarding_auto_route || false;
  const autoL2 = settings.engine_l2_auto_escalate || false;

  let doctorStatus = 'missing', doctorDetail = null, matchedAccount = null;
  let officeStatus = 'missing', officeDetail = null;
  let suggestions = [];
  let triageSuggestions = [];

  // ── Doctor lookup ──
  if (c.doctor_name) {
    const parts = c.doctor_name.replace(/^Dr\.?\s*/i, '').trim().split(/\s+/);
    const lastName = parts[parts.length - 1];

    const { data: accts } = await supabase.from('Accounts')
      .select('"Account Number", "First Name", "Last Name", "Practice Name", "Location"')
      .ilike('Last Name', '%' + lastName + '%')
      .limit(50);

    if (accts && accts.length > 0) {
      accts.slice(0, 5).forEach(a => {
        const fullName = `${a['First Name'] || ''} ${a['Last Name'] || ''}`.trim();
        const nameScore = normalize(a['Last Name']) === normalize(lastName) ? 80 : 40;
        triageSuggestions.push({ name: fullName, practice: a['Practice Name'] || '', account: a['Account Number'] || '', score: nameScore, type: 'doctor' });
      });

      const exactLast = accts.filter(a => normalize(a['Last Name']) === normalize(lastName));

      if (exactLast.length > 0) {
        if (parts.length > 1) {
          const firstName = parts[0];
          const exactFull = exactLast.find(a =>
            normalize(a['First Name']).startsWith(normalize(firstName).substring(0, 3))
          );
          if (exactFull) {
            doctorStatus = 'match';
            doctorDetail = `${exactFull['First Name']} ${exactFull['Last Name']} [${exactFull['Account Number']}] ${exactFull['Practice Name'] || ''}`.trim();
            matchedAccount = exactFull['Account Number'];
          } else {
            doctorStatus = 'partial';
            const best = exactLast[0];
            doctorDetail = `Last name match: ${best['First Name']} ${best['Last Name']} [${best['Account Number']}] — verify first name`;
            matchedAccount = best['Account Number'];
            suggestions.push('Doctor fuzzy match — first name mismatch, verify identity');
          }
        } else {
          if (exactLast.length === 1) {
            doctorStatus = 'match';
            const a = exactLast[0];
            doctorDetail = `${a['First Name']} ${a['Last Name']} [${a['Account Number']}]`;
            matchedAccount = a['Account Number'];
          } else {
            doctorStatus = 'partial';
            doctorDetail = `${exactLast.length} accounts match "${lastName}" — verify`;
            suggestions.push(`Multiple accounts match doctor last name "${lastName}"`);
          }
        }
      } else {
        doctorStatus = 'partial';
        const best = accts[0];
        doctorDetail = `Fuzzy: ${best['First Name']} ${best['Last Name']} [${best['Account Number']}]`;
        matchedAccount = best['Account Number'];
        suggestions.push('Doctor name is a fuzzy match only — verify identity');
      }
    } else {
      doctorStatus = 'no_match';
      doctorDetail = `No account found for "${c.doctor_name}"`;
      suggestions.push('Doctor not found in system');
    }
  } else {
    suggestions.push('Missing doctor name on RX');
  }

  // ── Office/Practice lookup ──
  if (c.office_name) {
    const officeTokens = tokenize(c.office_name);
    const searchTerm = officeTokens.length > 0 ? officeTokens[0] : c.office_name;

    const { data: offices } = await supabase.from('Accounts')
      .select('"Account Number", "First Name", "Last Name", "Practice Name"')
      .ilike('Practice Name', '%' + searchTerm + '%')
      .limit(50);

    if (offices && offices.length > 0) {
      let bestScore = 0, bestMatch = null;
      const scored = [];
      offices.forEach(o => {
        const score = jaccard(c.office_name, o['Practice Name'] || '');
        scored.push({ o, score });
        if (score > bestScore) { bestScore = score; bestMatch = o; }
      });
      scored.sort((a, b) => b.score - a.score);
      scored.slice(0, 5).forEach(s => {
        triageSuggestions.push({ name: `${s.o['First Name'] || ''} ${s.o['Last Name'] || ''}`.trim(), practice: s.o['Practice Name'] || '', account: s.o['Account Number'] || '', score: Math.round(s.score * 100), type: 'office' });
      });

      if (bestScore >= 0.6) {
        officeStatus = 'match';
        officeDetail = `${bestMatch['Practice Name']} [${bestMatch['Account Number']}]`;
        if (!matchedAccount) matchedAccount = bestMatch['Account Number'];
      } else if (bestScore >= 0.3) {
        officeStatus = 'partial';
        officeDetail = `Possible: ${bestMatch['Practice Name']} [${bestMatch['Account Number']}] (${Math.round(bestScore * 100)}%)`;
        suggestions.push('Office fuzzy match — verify practice');
      } else {
        officeStatus = 'no_match';
        officeDetail = `No matching practice for "${c.office_name}"`;
        suggestions.push('Office/practice not found in system');
      }
    } else {
      officeStatus = 'no_match';
      officeDetail = `No matching practice for "${c.office_name}"`;
      suggestions.push('Office/practice not found in system');
    }
  }

  // ── Missing field checks ──
  if (!c.patient_first && !c.patient_last) suggestions.push('Missing patient name');
  if (!c.material) suggestions.push('Missing material');
  if (!c.shade) suggestions.push('Missing shade');
  if (!c.teeth) suggestions.push('Missing teeth info');

  // ── Triage score ──
  let score = 100;
  if (doctorStatus === 'no_match') score -= 30;
  else if (doctorStatus === 'partial') score -= 15;
  else if (doctorStatus === 'missing') score -= 25;
  if (officeStatus === 'no_match') score -= 20;
  else if (officeStatus === 'partial') score -= 10;
  if (!c.patient_first || !c.patient_last) score -= 10;
  if (!c.material) score -= 5;
  if (!c.shade) score -= 5;
  if (!c.teeth) score -= 5;
  score = Math.max(0, score);

  // ── Routing decision ──
  const update = {
    doctor_match_status: doctorStatus,
    doctor_match_detail: doctorDetail,
    office_match_status: officeStatus,
    office_match_detail: officeDetail,
    engine_suggestions: suggestions,
    engine_status: 'triaged',
    qc_matched_account: matchedAccount,
    triage_flags: suggestions,
    triage_suggestions: triageSuggestions,
    triage_score: score,
    updated_at: new Date().toISOString()
  };

  // Onboarding routing
  if (doctorStatus === 'no_match' && officeStatus !== 'match') {
    if (autoOnboard) {
      const teamId = teams['onboarding'];
      if (teamId) {
        update.current_team_id = teamId;
        update.status = 'pending';
        update.assigned_to = null;
        suggestions.push('Auto-routed to Onboarding (doctor/office not found)');
      }
    } else {
      suggestions.push('Onboarding candidate — doctor/office not in system');
    }
  }
  // L2 escalation
  else if ((doctorStatus === 'partial' || suggestions.length >= 3) && doctorStatus !== 'no_match') {
    if (autoL2) {
      const teamId = teams['level_2_oc'];
      if (teamId) {
        update.current_team_id = teamId;
        update.status = 'pending';
        update.assigned_to = null;
        suggestions.push('Auto-escalated to OC C&B Level 2');
      }
    } else {
      suggestions.push('Consider escalating to OC C&B Level 2');
    }
  }

  update.engine_suggestions = suggestions;
  update.triage_flags = suggestions;
  await supabase.from('workflow_cases').update(update).eq('id', caseId);

  await supabase.from('workflow_case_history').insert({
    case_id: caseId,
    action: 'engine_triage',
    to_status: update.status || c.status,
    performed_by: null,
    notes: `Engine triage: Dr=${doctorStatus}, Office=${officeStatus}, Score=${score}`
  });

  return { caseId, doctorStatus, officeStatus, score };
}

// ═══════════════════════════════════════════════════════
// TEETH VALIDATION — compare RX teeth against Case Teeth
// ═══════════════════════════════════════════════════════
async function validateTeeth(supabase, caseNumber, rxTeeth) {
  if (!caseNumber || !rxTeeth) return null;

  const issues = [];

  // Parse RX teeth from the workflow case (comma-separated string like "8, 9, 10")
  const rxTeethSet = new Set(
    (typeof rxTeeth === 'string' ? rxTeeth : String(rxTeeth))
      .split(/[,;\s]+/)
      .map(t => t.replace(/^#/, '').trim())
      .filter(t => /^\d+$/.test(t))
      .map(Number)
  );

  if (rxTeethSet.size === 0) return null; // no parseable teeth on RX

  // Get tooth numbers from Cases table
  const { data: absCase } = await supabase.from('Cases')
    .select('"Case Number", "Tooth Numbers", "Tooth Count"')
    .eq('Case Number', caseNumber)
    .limit(1);

  // Get individual tooth products from Case Teeth table
  const { data: caseTeeth } = await supabase.from('Case Teeth')
    .select('"Case Number", "Tooth Number", "Product", "Product Number"')
    .eq('Case Number', caseNumber);

  // Parse ABS tooth numbers
  let absTeethSet = new Set();
  if (absCase && absCase.length > 0 && absCase[0]['Tooth Numbers']) {
    const absTeethStr = absCase[0]['Tooth Numbers'];
    absTeethStr.split(/[,;\s]+/)
      .map(t => t.replace(/^#/, '').trim())
      .filter(t => /^\d+$/.test(t))
      .forEach(t => absTeethSet.add(Number(t)));
  }

  // Parse Case Teeth table entries
  let caseTeethSet = new Set();
  if (caseTeeth && caseTeeth.length > 0) {
    caseTeeth.forEach(ct => {
      if (ct['Tooth Number']) {
        const tn = String(ct['Tooth Number']).trim();
        if (/^\d+$/.test(tn)) caseTeethSet.add(Number(tn));
      }
    });
  }

  // Compare RX teeth vs ABS "Tooth Numbers" column
  if (absTeethSet.size > 0) {
    const inRxNotAbs = [...rxTeethSet].filter(t => !absTeethSet.has(t));
    const inAbsNotRx = [...absTeethSet].filter(t => !rxTeethSet.has(t));
    if (inRxNotAbs.length > 0) {
      issues.push(`Teeth on RX but not in ABS: ${inRxNotAbs.join(', ')}`);
    }
    if (inAbsNotRx.length > 0) {
      issues.push(`Teeth in ABS but not on RX: ${inAbsNotRx.join(', ')}`);
    }
  }

  // Compare RX teeth vs Case Teeth table
  if (caseTeethSet.size > 0) {
    const inRxNotCT = [...rxTeethSet].filter(t => !caseTeethSet.has(t));
    const inCTNotRx = [...caseTeethSet].filter(t => !rxTeethSet.has(t));
    if (inRxNotCT.length > 0) {
      issues.push(`Teeth on RX but not in Case Teeth: ${inRxNotCT.join(', ')}`);
    }
    if (inCTNotRx.length > 0) {
      issues.push(`Teeth in Case Teeth but not on RX: ${inCTNotRx.join(', ')}`);
    }
  }

  // Tooth count check
  if (absCase && absCase.length > 0 && absCase[0]['Tooth Count'] != null) {
    const absCount = Number(absCase[0]['Tooth Count']);
    if (absCount > 0 && rxTeethSet.size !== absCount) {
      issues.push(`Tooth count mismatch: RX has ${rxTeethSet.size}, ABS says ${absCount}`);
    }
  }

  return {
    rxTeeth: [...rxTeethSet].sort((a, b) => a - b),
    absTeeth: [...absTeethSet].sort((a, b) => a - b),
    caseTeeth: [...caseTeethSet].sort((a, b) => a - b),
    caseTeethProducts: caseTeeth || [],
    issues
  };
}

// ═══════════════════════════════════════════════════════
// QC VALIDATION — case number lookup + field comparison
// ═══════════════════════════════════════════════════════
async function runQcValidation(supabase, caseId) {
  const { data: c, error } = await supabase.from('workflow_cases')
    .select('*').eq('id', caseId).single();
  if (error || !c) return null;

  if (!c.case_number) {
    await supabase.from('workflow_cases').update({
      needs_attention: true,
      attention_reason: 'Missing case number',
      updated_at: new Date().toISOString()
    }).eq('id', caseId);
    return { status: 'missing_case_number' };
  }

  // Look up case in ABS Cases table
  const { data: absCases, error: absErr } = await supabase.from('Cases')
    .select('"Case Number", "Patient First Name", "Patient Last Name", "Account Number", "Case Status", "Primary Product", "Pan Number", "Received Date"')
    .eq('Case Number', c.case_number)
    .limit(1);

  const checkCount = (c.qc_check_count || 0) + 1;

  if (absErr || !absCases || absCases.length === 0) {
    if (checkCount >= 3) {
      await supabase.from('workflow_cases').update({
        qc_check_count: checkCount,
        qc_last_check_at: new Date().toISOString(),
        needs_attention: true,
        attention_reason: `Case ${c.case_number} not found in ABS after ${checkCount} checks`,
        engine_status: 'qc_failed',
        updated_at: new Date().toISOString()
      }).eq('id', caseId);

      await supabase.from('workflow_case_history').insert({
        case_id: caseId,
        action: 'qc_failed',
        performed_by: null,
        notes: `Case ${c.case_number} not found in ABS after ${checkCount} attempts`
      });
      return { found: false, checkCount, status: 'failed' };
    } else {
      await supabase.from('workflow_cases').update({
        qc_check_count: checkCount,
        qc_last_check_at: new Date().toISOString(),
        engine_status: 'qc_retry_' + checkCount,
        updated_at: new Date().toISOString()
      }).eq('id', caseId);
      return { found: false, checkCount, status: 'retry' };
    }
  }

  // Found — compare data
  const abs = absCases[0];
  const issues = [];

  // Patient name check
  if (c.patient_first && abs['Patient First Name']) {
    if (normalize(c.patient_first) !== normalize(abs['Patient First Name'])) {
      issues.push(`Patient first name: RX="${c.patient_first}" vs ABS="${abs['Patient First Name']}"`);
    }
  }
  if (c.patient_last && abs['Patient Last Name']) {
    if (normalize(c.patient_last) !== normalize(abs['Patient Last Name'])) {
      issues.push(`Patient last name: RX="${c.patient_last}" vs ABS="${abs['Patient Last Name']}"`);
    }
  }

  // Account number check
  if (c.qc_matched_account && abs['Account Number']) {
    if (c.qc_matched_account !== abs['Account Number']) {
      issues.push(`Account: Engine matched "${c.qc_matched_account}" but ABS has "${abs['Account Number']}"`);
    }
  }

  // PAN check
  if (c.case_pan && abs['Pan Number']) {
    if (c.case_pan !== abs['Pan Number'] && c.case_pan !== '0') {
      issues.push(`PAN: RX="${c.case_pan}" vs ABS="${abs['Pan Number']}"`);
    }
  }

  // ── Teeth validation ──
  const teethResult = await validateTeeth(supabase, c.case_number, c.teeth);
  if (teethResult && teethResult.issues.length > 0) {
    teethResult.issues.forEach(ti => issues.push(ti));
  }

  // Filter out previously dismissed issues
  const prevResult = typeof c.qc_validation_result === 'string'
    ? JSON.parse(c.qc_validation_result || '{}')
    : (c.qc_validation_result || {});
  const dismissed = prevResult.dismissed_issues || [];
  const activeIssues = issues.filter(i => !dismissed.includes(i));

  const validationResult = {
    abs_case_number: abs['Case Number'],
    abs_account: abs['Account Number'],
    abs_patient: `${abs['Patient First Name'] || ''} ${abs['Patient Last Name'] || ''}`.trim(),
    abs_status: abs['Case Status'],
    abs_product: abs['Primary Product'],
    abs_received: abs['Received Date'],
    abs_pan: abs['Pan Number'] || '',
    teeth: teethResult || null,
    issues: activeIssues,
    dismissed_issues: dismissed,
    checked_at: new Date().toISOString()
  };

  if (activeIssues.length === 0) {
    const verifyUpdate = {
      qc_check_count: checkCount,
      qc_last_check_at: new Date().toISOString(),
      qc_validation_result: validationResult,
      engine_status: 'qc_verified',
      status: 'validated',
      validated_at: new Date().toISOString(),
      needs_attention: false,
      attention_reason: null,
      quality_score: 100,
      updated_at: new Date().toISOString()
    };
    if (abs['Pan Number'] && String(abs['Pan Number']) !== '0') {
      verifyUpdate.case_pan = abs['Pan Number'];
    }
    await supabase.from('workflow_cases').update(verifyUpdate).eq('id', caseId);

    await supabase.from('workflow_case_history').insert({
      case_id: caseId,
      action: 'qc_verified',
      from_status: c.status,
      to_status: 'validated',
      performed_by: null,
      notes: 'Engine QC: All fields match ABS — auto-verified'
    });
    return { found: true, issues: [], status: 'verified' };
  } else {
    const qScore = Math.max(0, 100 - (activeIssues.length * 20));
    await supabase.from('workflow_cases').update({
      qc_check_count: checkCount,
      qc_last_check_at: new Date().toISOString(),
      qc_validation_result: validationResult,
      engine_status: 'qc_issues',
      needs_attention: true,
      attention_reason: `${activeIssues.length} discrepancy${activeIssues.length > 1 ? 'ies' : ''} found vs ABS`,
      quality_score: qScore,
      quality_issues: activeIssues,
      updated_at: new Date().toISOString()
    }).eq('id', caseId);

    await supabase.from('workflow_case_history').insert({
      case_id: caseId,
      action: 'qc_issues',
      performed_by: null,
      notes: `Engine QC: ${activeIssues.length} discrepancies — ${activeIssues.join('; ')}${dismissed.length ? ' (' + dismissed.length + ' dismissed)' : ''}`
    });
    return { found: true, issues: activeIssues, status: 'attention' };
  }
}

// ═══════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  // Allow GET (cron) and POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: cron requests carry CRON_SECRET, manual requests carry the anon key
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;

  // For cron jobs, Vercel sends the CRON_SECRET as Authorization: Bearer <secret>
  const isCron = authHeader === `Bearer ${cronSecret}`;

  // For manual triggers, validate the Supabase anon key
  const isManual = authHeader === `Bearer ${process.env.SUPABASE_ANON_KEY}`;

  if (!isCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || 'https://asdunkqodixbhbohxtuq.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const settings = await loadSettings(supabase);
    const teams = await loadTeams(supabase);
    const results = { triage: [], qc: [], errors: [] };

    // ── Triage: pending cases with extracted data but no triage yet ──
    const { data: needsTriage } = await supabase.from('workflow_cases')
      .select('id, doctor_name, office_name, status, engine_status')
      .eq('status', 'pending')
      .or('engine_status.is.null,engine_status.eq.pending_triage')
      .not('doctor_name', 'is', null)
      .limit(10);

    if (needsTriage && needsTriage.length > 0) {
      // Also include cases that have office_name but no doctor_name
      for (const c of needsTriage) {
        try {
          const r = await runTriage(supabase, c.id, settings, teams);
          if (r) results.triage.push(r);
        } catch (e) {
          results.errors.push({ caseId: c.id, phase: 'triage', error: e.message });
        }
      }
    }

    // Also triage cases that have office_name but null doctor_name
    const { data: officeOnly } = await supabase.from('workflow_cases')
      .select('id, office_name, status, engine_status')
      .eq('status', 'pending')
      .is('doctor_name', null)
      .not('office_name', 'is', null)
      .or('engine_status.is.null,engine_status.eq.pending_triage')
      .limit(10);

    if (officeOnly && officeOnly.length > 0) {
      for (const c of officeOnly) {
        try {
          const r = await runTriage(supabase, c.id, settings, teams);
          if (r) results.triage.push(r);
        } catch (e) {
          results.errors.push({ caseId: c.id, phase: 'triage', error: e.message });
        }
      }
    }

    // ── QC Validation: quality_review/complete cases with case numbers ──
    const { data: needsQc } = await supabase.from('workflow_cases')
      .select('id, case_number, status, engine_status, qc_check_count, qc_last_check_at')
      .in('status', ['quality_review', 'complete'])
      .not('case_number', 'is', null)
      .not('engine_status', 'in', '("qc_verified","qc_failed")')
      .lt('qc_check_count', 3)
      .limit(20);

    if (needsQc && needsQc.length > 0) {
      for (const c of needsQc) {
        // Only check if last check was > 5 min ago (server runs every 5 min)
        if (c.qc_last_check_at) {
          const minsSince = (Date.now() - new Date(c.qc_last_check_at).getTime()) / 60000;
          if (minsSince < 5) continue;
        }
        try {
          const r = await runQcValidation(supabase, c.id);
          if (r) results.qc.push({ caseId: c.id, ...r });
        } catch (e) {
          results.errors.push({ caseId: c.id, phase: 'qc', error: e.message });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      triaged: results.triage.length,
      qcChecked: results.qc.length,
      errors: results.errors.length,
      details: results
    });
  } catch (e) {
    console.error('Engine error:', e);
    return res.status(500).json({ error: e.message });
  }
};
