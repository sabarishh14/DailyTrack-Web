import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from './SabDekho';

import { API } from '../constants';
import { accountOptions, getToken, evaluateMath, buildDescriptionIndex, guessDescription, categoriesForType, descriptionOptions } from '../utils';
import { useMoneyMeta, EMPTY_META } from '../api/money';
import CustomSelect from '../components/CustomSelect';
import AutocompleteInput from '../components/AutocompleteInput';
import TmdbMovieSearchInput from '../components/TmdbMovieSearchInput';
import TagPillInput from '../components/TagPillInput';
import { BalancesPanel, projectBalances } from '../components/BalanceImpact';

function AddTab({ accounts, categories, onAdd, dataVersion }) {
  const today = new Date().toISOString().split('T')[0];

  // Suggestions come pre-grouped from the server instead of from every transaction.
  const meta = useMoneyMeta(dataVersion).data || EMPTY_META;

  // Description suggestion: once category (and ideally amount) is set, suggest
  // a description from how this type + category has been described before.
  // Built once per data refresh, reused on every guess.
  const descriptionIndex = useMemo(() => buildDescriptionIndex(meta.descriptions), [meta.descriptions]);

  const createEmptyRow = () => ({
    id: Date.now() + Math.random(),
    account: 'KOTAK',
    date: today,
    type: 'Debit',
    heading: '',
    description: '',
    descriptionAuto: false,
    amount: '',
    movie_tags: [],
    movie_data: null,
    isSplit: false,
    split_data: { total_amount: 0, members: [], gdrive_link: '', loading: false }
  });

  // MAGICAL AUTO-SAVE: Loads data from local storage so nothing is ever lost!
  const [rows, setRows] = useState(() => {
    const saved = localStorage.getItem('dt_draft_txs');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.length > 0) {
          if (parsed.length === 1 && !parsed[0].amount && !parsed[0].heading && !parsed[0].description) {
            parsed[0].date = new Date().toISOString().split('T')[0];
          }
          return parsed;
        }
      } catch (e) { }
    }
    return [createEmptyRow()];
  });

  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [submitMessage, setSubmitMessage] = useState(null);
  // What the last save moved, per account; shown until the next save.
  const [savedBalances, setSavedBalances] = useState(null);

  // Just after a save the saved rows linger for a moment while balances have
  // already refreshed, so they mustn't be counted a second time.
  const projections = useMemo(() => success ? {} : projectBalances(rows, accounts), [rows, accounts, success]);

  // MAGICAL AUTO-SAVE: Saves to local storage every time you type a letter
  useEffect(() => {
    localStorage.setItem('dt_draft_txs', JSON.stringify(rows));
  }, [rows]);

  const updateRow = (id, field, value) => {
    setRows(prevRows => prevRows.map(row => row.id === id ? { ...row, [field]: value } : row));
  };

  // Fires once category and/or amount are known. Never overrides a description
  // the user typed themselves — only fills in an empty one, or refines its own
  // earlier guess (e.g. once amount narrows down which vendor in the category).
  const maybeSuggestDescription = (id, heading, amount) => {
    setRows(prevRows => prevRows.map(row => {
      if (row.id !== id) return row;
      if (row.description.trim() !== '' && !row.descriptionAuto) return row;
      const guess = guessDescription(row.type, heading, amount, descriptionIndex);
      if (!guess || guess === row.description) return row;
      return { ...row, description: guess, descriptionAuto: true };
    }));
  };

  const addRow = () => {
    const lastRow = rows[rows.length - 1];
    setRows([...rows, {
      ...lastRow,
      id: Date.now() + Math.random(),
      amount: '',
      description: '',
      descriptionAuto: false,
      movie_tags: [],
      movie_data: null,
      isSplit: false,
      split_data: { total_amount: 0, members: [], gdrive_link: '', loading: false }
    }]);
  };

  const removeRow = (id) => {
    if (rows.length === 1) {
      setRows([createEmptyRow()]);
      return;
    }
    setRows(rows.filter(r => r.id !== id));
  };

  const insertRowAfter = (index) => {
    const sourceRow = rows[index];
    const newRow = {
      ...sourceRow,
      id: Date.now() + Math.random(),
      amount: '',
      description: '',
      descriptionAuto: false,
      movie_tags: [],
      movie_data: null,
      isSplit: false,
      split_data: { total_amount: 0, members: [], gdrive_link: '', loading: false }
    };
    const newRows = [...rows];
    newRows.splice(index + 1, 0, newRow);
    setRows(newRows);
  };

  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const handleDragStart = (e, index) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDrop = (e, dropIndex) => {
    e.preventDefault();
    setDragOverIndex(null);
    if (draggedIndex === null || draggedIndex === dropIndex) return;

    const newRows = [...rows];
    const draggedItem = newRows[draggedIndex];
    
    // Remove from old position and insert at new position
    newRows.splice(draggedIndex, 1);
    newRows.splice(dropIndex, 0, draggedItem);
    
    setRows(newRows);
    setDraggedIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleOcrSplit = async (rowId) => {
    const row = rows.find(r => r.id === rowId);
    const currentSplit = row.split_data || { members: [], total_amount: 0, loading: false };
    updateRow(rowId, 'split_data', { ...currentSplit, loading: true });
    try {
      const res = await fetch(`${API}/sync/ocr-split`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await res.json();
      if (data.success) {
        let myAmount = 0;
        const youMember = data.members.find(m => m.name.toLowerCase() === 'you');
        if (youMember) myAmount += parseFloat(youMember.amount) || 0;

        myAmount += data.members
          .filter(m => m.name.toLowerCase() !== 'you' && !m.paid)
          .reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0);

        setRows(prevRows => prevRows.map(r =>
          r.id === rowId ? {
            ...r,
            amount: myAmount > 0 ? Math.round(myAmount) : r.amount,
            split_data: { ...currentSplit, total_amount: data.total_amount, members: data.members, loading: false }
          } : r
        ));
      } else {
        alert("OCR Failed: " + data.message);
        updateRow(rowId, 'split_data', { ...currentSplit, loading: false });
      }
    } catch (e) {
      alert("Error: " + e.message);
      updateRow(rowId, 'split_data', { ...currentSplit, loading: false });
    }
  };

  const submit = async () => {
    const evaluatedRows = rows.map(r => {
      const eAmt = evaluateMath(r.amount);
      return { ...r, amount: eAmt !== null ? eAmt : r.amount };
    });
    setRows(evaluatedRows);

    for (let i = 0; i < evaluatedRows.length; i++) {
      if (rows[i].amount && evaluateMath(rows[i].amount) === null) {
        return alert(`Row ${i + 1} has an invalid math calculation in the amount field.`);
      }
      if (!evaluatedRows[i].amount || isNaN(evaluatedRows[i].amount) || !evaluatedRows[i].heading.trim()) {
        return alert(`Row ${i + 1} is missing a valid amount or category.`);
      }
    }

    setLoading(true);
    setSubmitMessage(null);
    setSavedBalances(null);
    try {
      const payload = evaluatedRows.map(r => {
        const catName = r.heading.trim();

        const payloadRow = {
          account: r.account,
          date: r.date,
          type: r.type,
          heading: catName,
          description: r.description.trim() || "",
          amount: parseFloat(r.amount),
          // ✨ MAGIC RULE (now server-side): if every earlier transaction in this
          // category is excluded, the backend excludes this new one too.
          exclude_analytics: false,
movie_tags: r.movie_tags,
          movie_data: r.movie_data,
          lbx_username: localStorage.getItem('dt_lbx_username') || 'sabarishh14'
        };

        if (r.isSplit && r.split_data && r.split_data.members.length > 0) {
          payloadRow.split = {
            total_amount: parseFloat(r.split_data.total_amount) || 0,
            members: r.split_data.members
          };
        }
        return payloadRow;
      });

      const res = await fetch(`${API}/transactions`, {
        method: "POST", headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }, body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = await res.json();
        onAdd();
        setSuccess(true);
        setSubmitMessage({ type: 'success', text: data.message || "Successfully saved!" });
        setSavedBalances(data.balances || null);
        // Wipe local storage draft only on successful save
        localStorage.removeItem('dt_draft_txs');
        setTimeout(() => {
          setSuccess(false);
          setSubmitMessage(null);
          setRows([createEmptyRow()]);
        }, 3000);
      } else {
        const errText = await res.text();
        setSubmitMessage({ type: 'error', text: `Failed to save. Server returned: ${res.status}\n${errText.substring(0, 100)}` });
      }
    } catch (e) {
      setSubmitMessage({ type: 'error', text: "Network error: " + e.message + "\nDon't worry, your typed data is safely auto-saved!" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="section" style={{ animation: 'fadeUp 0.2s ease', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 className="section-title" style={{ margin: 0, border: 'none' }}>➕ Log Transactions</h2>
          <div style={{ fontSize: '0.85rem', color: 'var(--text3)', marginTop: '4px' }}>
            Your progress is auto-saved locally. Take your time!<br/>
            <span style={{ opacity: 0.7 }}>💡 <b>Pro Tip:</b> <kbd>Ctrl</kbd> + <kbd>Enter</kbd> saves · <kbd>Shift</kbd> + <kbd>Enter</kbd> adds a row below.</span>
          </div>
        </div>
        <div className="clear-drafts-wrapper">
          <button className="action-btn secondary clear-drafts-btn" onClick={() => {
            if (window.confirm("Are you sure you want to clear all drafts?")) {
              setRows([createEmptyRow()]);
              localStorage.removeItem('dt_draft_txs');
            }
          }}>
            🗑️ Clear Drafts
          </button>
        </div>
      </div>

      {submitMessage && (
        <div style={{
          padding: '12px 16px',
          marginBottom: '1rem',
          borderRadius: '8px',
          background: submitMessage.type === 'error' ? 'rgba(255, 60, 60, 0.1)' : 'rgba(40, 200, 100, 0.1)',
          border: `1px solid ${submitMessage.type === 'error' ? 'rgba(255, 60, 60, 0.3)' : 'rgba(40, 200, 100, 0.3)'}`,
          color: submitMessage.type === 'error' ? '#ff6b6b' : '#2ecc71',
          whiteSpace: 'pre-wrap',
          animation: 'fadeIn 0.2s ease',
          fontWeight: '500'
        }}>
          {submitMessage.text}
        </div>
      )}

      <BalancesPanel accounts={accounts} projected={projections} saved={savedBalances} />

      <div className="add-table-wrap" style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '1.5rem', overflowX: 'auto' }}>
        <div className="add-table-inner">

          <div className="bulk-grid bulk-header">
            <span>Account</span>
            <span>Date</span>
            <span>Type</span>
            <span>Category</span>
            <span>Amount (₹)</span>
            <span>Note</span>
            <span style={{ textAlign: 'center' }}>#</span>
          </div>

          {rows.map((row, index) => (
            <div 
              key={row.id} 
              style={{ 
                animation: 'fadeIn 0.2s ease', 
                marginBottom: '0.5rem', 
                opacity: draggedIndex === index ? 0.4 : 1, 
                transition: 'all 0.2s ease',
                position: 'relative',
                boxShadow: dragOverIndex === index ? (draggedIndex < index ? '0 2px 0 0 var(--accent)' : '0 -2px 0 0 var(--accent)') : 'none',
                zIndex: dragOverIndex === index ? 100 : rows.length - index
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                // Ctrl/⌘+Enter saves everything; Shift+Enter adds a row below this one.
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  if (!loading) submit();
                } else if (e.shiftKey) {
                  e.preventDefault();
                  insertRowAfter(index);
                }
              }}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={() => {
                if (dragOverIndex === index) {
                  setDragOverIndex(null);
                }
              }}
              onDrop={(e) => handleDrop(e, index)}
            >
              <div className="bulk-grid bulk-row" style={{ marginBottom: 0 }}>
                <CustomSelect
                  value={row.account}
                  onChange={val => updateRow(row.id, 'account', val)}
                  options={accountOptions([...meta.accounts, row.account])}
                  minWidth="140px"
                />

                <input type="date" className="bulk-inp" style={{ height: '36px' }} value={row.date} onChange={e => updateRow(row.id, 'date', e.target.value)} />

                <CustomSelect
                  value={row.type}
                  onChange={val => {
                    updateRow(row.id, 'type', val);
                    maybeSuggestDescription(row.id, row.heading, row.amount);
                  }}
                  options={[
                    { label: '🔴 Debit', value: 'Debit' },
                    { label: '🟢 Credit', value: 'Credit' },
                    { label: '💰 Savings', value: 'Savings' },
                    { label: '💸 Investment', value: 'Investment' }
                  ]}
                  minWidth="130px"
                />

                <AutocompleteInput
                  value={row.heading}
                  onChange={val => {
                    updateRow(row.id, 'heading', val);
                    maybeSuggestDescription(row.id, val, row.amount);
                  }}
                  options={categoriesForType(row.type, meta.categories_by_type, categories)}
                  placeholder="Category"
                />

                <input
                  type="text" className={`bulk-inp ${row.amount && evaluateMath(row.amount) === null ? 'invalid-math' : ''}`} placeholder="0.00"
                  value={row.amount}
                  onChange={e => updateRow(row.id, 'amount', e.target.value)}
                  onBlur={e => {
                    const evalAmt = evaluateMath(e.target.value);
                    const finalAmt = (evalAmt !== null && evalAmt !== '') ? evalAmt : e.target.value;
                    if (evalAmt !== null && evalAmt !== '') updateRow(row.id, 'amount', evalAmt);
                    maybeSuggestDescription(row.id, row.heading, finalAmt);
                  }}
                />

                {row.heading.trim().toLowerCase() === 'cinema' ? (
                  <TmdbMovieSearchInput
                    value={row.description}
                    onChange={val => updateRow(row.id, 'description', val)}
                    onSelectMovie={movie => updateRow(row.id, 'movie_data', movie)}
                    placeholder="Search movie..."
                  />
                ) : (
                  <AutocompleteInput
                    value={row.description}
                    onChange={val => {
                      updateRow(row.id, 'description', val);
                      if (row.descriptionAuto) updateRow(row.id, 'descriptionAuto', false);
                    }}
                    className={row.descriptionAuto ? 'auto-suggested' : ''}
                    options={descriptionOptions(row.type, row.heading, descriptionIndex)}
                    placeholder="Optional note..."
                  />
                )}

                <div className="bulk-actions-wrapper" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <div
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragEnd={handleDragEnd}
                    title="Drag to reorder"
                    style={{ cursor: 'grab', padding: '0 8px', color: 'var(--text3)', display: 'flex', alignItems: 'center', fontSize: '1.2rem', userSelect: 'none' }}
                  >
                    ⋮⋮
                  </div>
                  <button
                    className="bulk-split-btn"
                    onClick={() => updateRow(row.id, 'isSplit', !row.isSplit)}
                    title="Toggle Split Details"
                    style={{ background: row.isSplit ? 'var(--accent)' : 'transparent', color: row.isSplit ? '#fff' : 'inherit', fontSize: '1rem' }}
                  >
                    👥
                  </button>
                  <button
                    className="bulk-del-btn"
                    onClick={() => removeRow(row.id)}
                    title="Remove Row"
                  >
                    ×
                  </button>
                </div>
              </div>

              {row.heading.trim().toLowerCase() === 'cinema' && (
                <div style={{ margin: '0.5rem 0 1rem 0', padding: '1rem', background: 'var(--bg2)', borderRadius: '8px', border: '1px dashed var(--accent)' }}>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text2)', marginBottom: '0.5rem' }}>🎬 Movie Tags</div>
                  <TagPillInput
                    value={row.movie_tags}
                    onChange={tags => updateRow(row.id, 'movie_tags', tags)}
                  />
                </div>
              )}

              {row.isSplit && (
                <div style={{ margin: '0.5rem 0 1rem 0', padding: '1.25rem', background: 'var(--bg2)', borderRadius: '12px', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: '10px' }}>
                    <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text1)' }}>👥 Split Details</h4>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <button
                        className="action-btn"
                        style={{ padding: '6px 12px', fontSize: '0.85rem' }}
                        onClick={() => handleOcrSplit(row.id)}
                        disabled={row.split_data?.loading}
                      >
                        {row.split_data?.loading ? '⏳ Parsing...' : '🔍 Fetch Receipt'}
                      </button>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 200px' }}>
                      <label style={{ fontSize: '0.8rem', color: 'var(--text3)', display: 'block', marginBottom: '6px' }}>Total Bill Amount (₹)</label>
                      <input
                        type="number"
                        className="bulk-inp"
                        style={{ width: '100%', background: 'rgba(0,0,0,0.2)', color: 'var(--text3)', cursor: 'not-allowed' }}
                        value={row.split_data?.total_amount || 0}
                        readOnly
                        title="Auto-calculated from member amounts"
                      />

                      <div style={{ marginTop: '1.5rem' }}>
                        <button
                          className="action-btn"
                          style={{ width: '100%', justifyContent: 'center', padding: '10px', background: 'var(--accent)', color: '#fff' }}
                          onClick={() => {
                            if (!row.split_data || !row.split_data.members) return;
                            const members = row.split_data.members;
                            let myAmount = 0;
                            const youMember = members.find(m => m.name.toLowerCase() === 'you');
                            if (youMember) {
                              myAmount += parseFloat(youMember.amount) || 0;
                            }
                            const unpaidAmount = members
                              .filter(m => m.name.toLowerCase() !== 'you' && !m.paid)
                              .reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0);

                            myAmount += unpaidAmount;
                            updateRow(row.id, 'amount', Math.round(myAmount));
                          }}
                        >
                          🧮 Set My Transaction Amount
                        </button>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text3)', marginTop: '8px', lineHeight: '1.4' }}>
                          Calculates: <b>Your portion</b> + <b>All Unpaid portions</b>.
                        </p>
                      </div>
                    </div>

                    <div style={{ flex: '3 1 400px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--text3)' }}>Members (Parsed from screenshot)</label>
                        <button
                          className="action-btn secondary"
                          style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                          onClick={() => {
                            const currentSplit = row.split_data || { members: [], loading: false, total_amount: 0 };
                            updateRow(row.id, 'split_data', { ...currentSplit, members: [...currentSplit.members, { name: '', amount: 0, paid: false }] });
                          }}
                        >+ Add Member</button>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(0,0,0,0.1)', padding: '10px', borderRadius: '8px' }}>
                        {(!row.split_data || !row.split_data.members || row.split_data.members.length === 0) ? (
                          <div style={{ fontSize: '0.9rem', color: 'var(--text3)', fontStyle: 'italic', padding: '1rem', textAlign: 'center' }}>No members added. Fetch from folder or enter manually.</div>
                        ) : (
                          row.split_data.members.map((m, idx) => (
                            <div key={idx} style={{ display: 'flex', gap: '10px', alignItems: 'center', background: 'var(--card)', padding: '8px', borderRadius: '6px' }}>
                              <input
                                type="text"
                                className="bulk-inp"
                                style={{ flex: 2, background: 'transparent', border: '1px solid var(--border)' }}
                                value={m.name}
                                placeholder="Name"
                                onChange={e => {
                                  const newM = [...row.split_data.members];
                                  newM[idx].name = e.target.value;
                                  updateRow(row.id, 'split_data', { ...row.split_data, members: newM });
                                }}
                              />
                              <input
                                type="number"
                                className="bulk-inp"
                                style={{ flex: 1, background: 'transparent', border: '1px solid var(--border)' }}
                                value={m.amount}
                                placeholder="Amount"
                                onChange={e => {
                                  const newM = [...row.split_data.members];
                                  newM[idx].amount = e.target.value;
                                  const newTotal = newM.reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0);
                                  updateRow(row.id, 'split_data', { ...row.split_data, members: newM, total_amount: newTotal });
                                }}
                              />
                              <button
                                style={{
                                  padding: '6px 12px',
                                  borderRadius: '6px',
                                  border: 'none',
                                  fontSize: '0.75rem',
                                  fontWeight: 'bold',
                                  cursor: 'pointer',
                                  background: m.paid ? 'var(--pos)' : 'var(--bg2)',
                                  color: m.paid ? '#fff' : 'var(--text2)',
                                  width: '80px',
                                  transition: '0.2s'
                                }}
                                onClick={() => {
                                  const newM = [...row.split_data.members];
                                  newM[idx].paid = !newM[idx].paid;

                                  let myAmount = 0;
                                  const youMember = newM.find(m => m.name.toLowerCase() === 'you');
                                  if (youMember) myAmount += parseFloat(youMember.amount) || 0;
                                  myAmount += newM.filter(m => m.name.toLowerCase() !== 'you' && !m.paid).reduce((sum, m) => sum + (parseFloat(m.amount) || 0), 0);

                                  setRows(prevRows => prevRows.map(r =>
                                    r.id === row.id ? {
                                      ...r,
                                      amount: myAmount > 0 ? Math.round(myAmount) : r.amount,
                                      split_data: { ...r.split_data, members: newM }
                                    } : r
                                  ));
                                }}
                              >
                                {m.paid ? 'PAID' : 'UNPAID'}
                              </button>
                              <button
                                className="bulk-del-btn"
                                style={{ padding: '4px', background: 'transparent' }}
                                onClick={() => {
                                  const newM = row.split_data.members.filter((_, i) => i !== idx);
                                  updateRow(row.id, 'split_data', { ...row.split_data, members: newM });
                                }}
                              >×</button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}

          <datalist id="category-options">
            {categories.map(cat => <option key={cat} value={cat} />)}
          </datalist>

          <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <button className="action-btn secondary" onClick={addRow} style={{ flex: 1, justifyContent: 'center', padding: '0.85rem' }}>
              ➕ Add Row
            </button>

            <button className={`action-btn ${success ? 'success' : ''}`} onClick={submit} disabled={loading} style={{ flex: 2, justifyContent: 'center', padding: '0.85rem' }}>
              {loading ? "⏳ Saving Records..." : success ? "✅ Saved Successfully!" : `💾 Save Records (${rows.length})`}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default memo(AddTab);
