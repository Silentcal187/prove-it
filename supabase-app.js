import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const claimsGrid = document.getElementById('claimsGrid');
const resultsGrid = document.getElementById('resultsGrid');
const claimForm = document.getElementById('claimForm');
const authStatus = document.getElementById('authStatus');
const connectionStatus = document.getElementById('connectionStatus');
const loginButton = document.getElementById('loginButton');
const signupButton = document.getElementById('signupButton');
const logoutButton = document.getElementById('logoutButton');

let currentUser = null;
let claims = [];
let evidence = [];
let claimVotes = [];
let appealVotes = [];
let comments = [];
let commentVotes = [];
let profiles = [];

const SOURCE_LABELS = {
  peer_reviewed_study: 'Peer-reviewed study',
  university_study: 'University study',
  government_report: 'Government report',
  court_record: 'Court record',
  official_data: 'Official data',
  recognized_news: 'Recognized news',
  expert_article: 'Expert article',
  personal_experience: 'Personal experience',
  social_media: 'Social media',
  hearsay: 'Hearsay',
  unknown: 'Unknown'
};

function escapeHTML(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusLabel(status = '') {
  return status.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function isOpenClaim(claim) {
  return ['open', 'under_reassessment', 'additional_evidence_required'].includes(claim.status);
}

function getProfile(userId) {
  return profiles.find(profile => profile.id === userId);
}

function claimEvidence(claimId, stance = null) {
  return evidence.filter(item => item.claim_id === claimId && (!stance || item.stance === stance));
}

function claimVoteCounts(claimId) {
  const votes = claimVotes.filter(vote => vote.claim_id === claimId);
  return {
    agree: votes.filter(vote => vote.vote === 'agree').length,
    disagree: votes.filter(vote => vote.vote === 'disagree').length,
    needsEvidence: votes.filter(vote => vote.vote === 'needs_evidence').length,
    total: votes.length
  };
}

function appealCounts(claimId) {
  const votes = appealVotes.filter(vote => vote.claim_id === claimId);
  const reassess = votes.filter(vote => vote.vote === 'reassess').length;
  const keep = votes.filter(vote => vote.vote === 'keep_verdict').length;
  const total = votes.length;
  return { reassess, keep, total, pct: total ? Math.round((reassess / total) * 100) : 0 };
}

function commentVoteCounts(commentId) {
  const votes = commentVotes.filter(vote => vote.comment_id === commentId);
  return {
    agree: votes.filter(vote => vote.vote === 'agree').length,
    disagree: votes.filter(vote => vote.vote === 'disagree').length,
    total: votes.length
  };
}

function updateAuthStatus() {
  if (!currentUser) {
    authStatus.textContent = 'Not logged in. You can read claims, but voting and posting need login.';
    return;
  }

  const profile = getProfile(currentUser.id);
  const clout = profile ? profile.clout_points : 0;
  const cooldown = profile?.comment_cooldown_until ? new Date(profile.comment_cooldown_until) : null;
  const cooldownText = cooldown && cooldown > new Date() ? ` | Comment cooldown until ${cooldown.toLocaleString()}` : '';
  authStatus.textContent = `Logged in as ${currentUser.email}. Clout: ${clout}${cooldownText}`;
}

async function refreshSession() {
  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user || null;
}

async function loadData() {
  connectionStatus.textContent = 'Loading database data...';

  const [claimsRes, evidenceRes, votesRes, appealsRes, commentsRes, commentVotesRes, profilesRes] = await Promise.all([
    supabase.from('claims').select('*').order('created_at', { ascending: false }),
    supabase.from('evidence').select('*').order('created_at', { ascending: false }),
    supabase.from('claim_votes').select('*'),
    supabase.from('appeal_votes').select('*'),
    supabase.from('comments').select('*').order('created_at', { ascending: true }),
    supabase.from('comment_votes').select('*'),
    supabase.from('profiles').select('*')
  ]);

  const firstError = [claimsRes, evidenceRes, votesRes, appealsRes, commentsRes, commentVotesRes, profilesRes].find(res => res.error)?.error;
  if (firstError) throw firstError;

  claims = claimsRes.data || [];
  evidence = evidenceRes.data || [];
  claimVotes = votesRes.data || [];
  appealVotes = appealsRes.data || [];
  comments = commentsRes.data || [];
  commentVotes = commentVotesRes.data || [];
  profiles = profilesRes.data || [];

  connectionStatus.textContent = `Connected. Loaded ${claims.length} claims from Supabase.`;
  updateAuthStatus();
  render();
}

function evidenceList(items, emptyMessage) {
  if (!items.length) return `<p class="note">${emptyMessage}</p>`;

  return `<ul class="source-list">${items.map(item => `
    <li>
      <strong>${escapeHTML(item.title)}</strong><br />
      <span>${escapeHTML(item.source_name || 'Source')}</span> · ${escapeHTML(SOURCE_LABELS[item.source_type] || item.source_type)} · ${escapeHTML(statusLabel(item.ai_review_status))} · Weight ${Number(item.evidence_weight || 0).toFixed(2)}<br />
      ${item.source_url ? `<a href="${escapeHTML(item.source_url)}" target="_blank" rel="noopener">Open source</a>` : ''}
    </li>
  `).join('')}</ul>`;
}

function claimCard(claim) {
  const votes = claimVoteCounts(claim.id);
  const appeals = appealCounts(claim.id);
  const support = claimEvidence(claim.id, 'supports');
  const against = claimEvidence(claim.id, 'disproves');
  const context = claimEvidence(claim.id, 'context');
  const claimComments = comments.filter(comment => comment.claim_id === claim.id);

  return `
    <article class="claim-card" data-claim-id="${claim.id}">
      <div class="claim-topline">
        <span class="badge">${escapeHTML(statusLabel(claim.status))}</span>
        <span class="badge muted">${escapeHTML(claim.popularity_level || 'new')}</span>
      </div>
      <h3>${escapeHTML(claim.title)}</h3>
      <p>${escapeHTML(claim.claim_text)}</p>
      <p class="note">Voting closes: ${claim.voting_closes_at ? new Date(claim.voting_closes_at).toLocaleString() : 'Not set'}</p>

      <div class="vote-row">
        <button class="vote-btn" data-action="vote" data-vote="agree">Agree (${votes.agree})</button>
        <button class="vote-btn" data-action="vote" data-vote="disagree">Disagree (${votes.disagree})</button>
        <button class="vote-btn" data-action="vote" data-vote="needs_evidence">Needs Evidence (${votes.needsEvidence})</button>
      </div>

      <details>
        <summary>Evidence sources</summary>
        <h4>Supports the claim</h4>
        ${evidenceList(support, 'No supporting evidence yet.')}
        <h4>Disproves or challenges the claim</h4>
        ${evidenceList(against, 'No disproving evidence yet.')}
        <h4>Context / more evidence required</h4>
        ${evidenceList(context, 'No context evidence yet.')}
      </details>

      <details>
        <summary>Add evidence</summary>
        <form class="mini-form evidence-form">
          <label>Evidence stance
            <select name="stance">
              <option value="supports">Supports original claim</option>
              <option value="disproves">Disproves/challenges claim</option>
              <option value="context">Context / needs more evidence</option>
            </select>
          </label>
          <label>Evidence title<input name="title" required placeholder="Study, report, article, official data..." /></label>
          <label>Source name<input name="source_name" placeholder="University, government department, news outlet..." /></label>
          <label>Source URL<input name="source_url" type="url" placeholder="https://..." /></label>
          <label>Source type
            <select name="source_type">
              <option value="peer_reviewed_study">Peer-reviewed study</option>
              <option value="university_study">University study</option>
              <option value="government_report">Government report</option>
              <option value="court_record">Court record</option>
              <option value="official_data">Official data</option>
              <option value="recognized_news">Recognized news</option>
              <option value="expert_article">Expert article</option>
              <option value="personal_experience">Personal experience</option>
              <option value="social_media">Social media</option>
              <option value="hearsay">Hearsay</option>
            </select>
          </label>
          <button class="btn secondary" type="submit">Submit evidence</button>
        </form>
      </details>

      <details>
        <summary>Discussion (${claimComments.length})</summary>
        <div class="comments-list">
          ${claimComments.map(comment => {
            const author = getProfile(comment.user_id);
            const counts = commentVoteCounts(comment.id);
            return `
              <div class="comment-card" data-comment-id="${comment.id}">
                <p><strong>${escapeHTML(author?.display_name || author?.email || 'User')}</strong>: ${escapeHTML(comment.body)}</p>
                <p class="note">Statement vote: ${escapeHTML(statusLabel(comment.vote_status))} | Clout awarded: ${comment.clout_awarded}</p>
                <div class="vote-row">
                  <button class="vote-btn" data-action="comment-vote" data-vote="agree">Agree (${counts.agree})</button>
                  <button class="vote-btn" data-action="comment-vote" data-vote="disagree">Disagree (${counts.disagree})</button>
                </div>
              </div>
            `;
          }).join('') || '<p class="note">No comments yet.</p>'}
        </div>
        <form class="mini-form comment-form">
          <label>Add your thought<textarea name="body" required placeholder="State your point clearly. Try not to embarrass the species."></textarea></label>
          <label><input type="checkbox" name="called_to_vote" /> Call this statement to a vote</label>
          <button class="btn secondary" type="submit">Post comment</button>
        </form>
      </details>

      <details>
        <summary>Appeal / reassessment</summary>
        <p class="note">Reassessment needs more than 51% of appeal votes. Current: ${appeals.reassess}/${appeals.total} reassess (${appeals.pct}%).</p>
        <div class="vote-row">
          <button class="vote-btn" data-action="appeal" data-vote="reassess">Appeal: reassess</button>
          <button class="vote-btn" data-action="appeal" data-vote="keep_verdict">Keep verdict</button>
        </div>
      </details>
    </article>
  `;
}

function render() {
  const open = claims.filter(isOpenClaim);
  const results = claims.filter(claim => !isOpenClaim(claim));

  claimsGrid.innerHTML = open.length ? open.map(claimCard).join('') : '<p class="note">No open claims found.</p>';
  resultsGrid.innerHTML = results.length ? results.map(claimCard).join('') : '<p class="note">No closed claims yet.</p>';
}

async function requireUser() {
  await refreshSession();
  if (!currentUser) throw new Error('Log in first. The database refuses anonymous chaos. For once, reasonable.');
  return currentUser;
}

async function handleLogin() {
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await initialize();
}

async function handleSignup() {
  const email = document.getElementById('authEmail').value;
  const password = document.getElementById('authPassword').value;
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  await initialize();
}

async function handleLogout() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  await initialize();
}

async function createClaim(event) {
  event.preventDefault();
  const user = await requireUser();
  const title = document.getElementById('claimTitle').value.trim();
  const claim_text = document.getElementById('claimReason').value.trim();
  const category = document.getElementById('claimCategory').value.trim() || 'General';

  const { error } = await supabase.from('claims').insert({
    title,
    claim_text,
    category,
    status: 'open',
    created_by: user.id
  });
  if (error) throw error;
  claimForm.reset();
  await loadData();
}

async function voteOnClaim(claimId, vote) {
  const user = await requireUser();
  const { error } = await supabase.from('claim_votes').upsert({
    claim_id: claimId,
    user_id: user.id,
    vote,
    vote_weight: 1
  }, { onConflict: 'claim_id,user_id' });
  if (error) throw error;
  await loadData();
}

async function appealClaim(claimId, vote) {
  const user = await requireUser();
  const { error } = await supabase.from('appeal_votes').upsert({
    claim_id: claimId,
    user_id: user.id,
    vote
  }, { onConflict: 'claim_id,user_id' });
  if (error) throw error;
  await supabase.rpc('apply_appeal_result', { target_claim_id: claimId });
  await loadData();
}

async function submitEvidence(event, claimId) {
  event.preventDefault();
  const user = await requireUser();
  const formData = new FormData(event.target);
  const { error } = await supabase.from('evidence').insert({
    claim_id: claimId,
    submitted_by: user.id,
    stance: formData.get('stance'),
    title: formData.get('title'),
    source_name: formData.get('source_name'),
    source_url: formData.get('source_url'),
    source_type: formData.get('source_type'),
    ai_review_status: 'pending',
    evidence_weight: 0.30,
    is_allowed_as_evidence: true
  });
  if (error) throw error;
  await loadData();
}

async function submitComment(event, claimId) {
  event.preventDefault();
  const user = await requireUser();
  const formData = new FormData(event.target);
  const { error } = await supabase.from('comments').insert({
    claim_id: claimId,
    user_id: user.id,
    body: formData.get('body'),
    called_to_vote: formData.get('called_to_vote') === 'on'
  });
  if (error) throw error;
  await loadData();
}

async function voteOnComment(commentId, vote) {
  const user = await requireUser();
  const { error } = await supabase.from('comment_votes').upsert({
    comment_id: commentId,
    user_id: user.id,
    vote
  }, { onConflict: 'comment_id,user_id' });
  if (error) throw error;
  await loadData();
}

async function handleGridClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const claimCard = button.closest('[data-claim-id]');
  const commentCard = button.closest('[data-comment-id]');
  const action = button.dataset.action;
  const vote = button.dataset.vote;

  try {
    if (action === 'vote') await voteOnClaim(claimCard.dataset.claimId, vote);
    if (action === 'appeal') await appealClaim(claimCard.dataset.claimId, vote);
    if (action === 'comment-vote') await voteOnComment(commentCard.dataset.commentId, vote);
  } catch (error) {
    alert(error.message);
  }
}

async function handleGridSubmit(event) {
  const evidenceForm = event.target.closest('.evidence-form');
  const commentForm = event.target.closest('.comment-form');
  if (!evidenceForm && !commentForm) return;

  const claimCard = event.target.closest('[data-claim-id]');
  try {
    if (evidenceForm) await submitEvidence(event, claimCard.dataset.claimId);
    if (commentForm) await submitComment(event, claimCard.dataset.claimId);
  } catch (error) {
    alert(error.message);
  }
}

async function initialize() {
  try {
    await refreshSession();
    await loadData();
  } catch (error) {
    connectionStatus.textContent = `Connection/setup error: ${error.message}`;
    console.error(error);
  }
}

loginButton.addEventListener('click', () => handleLogin().catch(error => alert(error.message)));
signupButton.addEventListener('click', () => handleSignup().catch(error => alert(error.message)));
logoutButton.addEventListener('click', () => handleLogout().catch(error => alert(error.message)));
claimForm.addEventListener('submit', event => createClaim(event).catch(error => alert(error.message)));
claimsGrid.addEventListener('click', handleGridClick);
resultsGrid.addEventListener('click', handleGridClick);
claimsGrid.addEventListener('submit', handleGridSubmit);
resultsGrid.addEventListener('submit', handleGridSubmit);
supabase.auth.onAuthStateChange(() => initialize());

initialize();
