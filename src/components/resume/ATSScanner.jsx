import React, { useState, useCallback, useMemo } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FiUpload,
  FiCheckCircle,
  FiAlertCircle,
  FiTrendingUp,
  FiFile,
  FiDownload,
  FiCopy,
  FiAward,
  FiCode,
  FiRefreshCw,
  FiInfo,
  FiBarChart2,
} from 'react-icons/fi';
import Card from '../ui/Card';
import Button from '../ui/Button';
import Progress from '../ui/Progress';
import Badge from '../ui/Badge';
import Modal from '../ui/Modal';
import { parseResumeFile } from '../../utils/resumeParser';
import { calculateDetailedScore } from '../../utils/atsScoring';
import { detectIndustry, suggestKeywords } from '../../utils/atsKeywords';
import { INDUSTRIES } from '../../data/constants';
import toast from 'react-hot-toast';
import ATSScoreMeter from './ATSScoreMeter';

// ── Constants ─────────────────────────────────────────────────────────────

const ACCEPTED_TYPES = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'text/plain': ['.txt'],
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const PRIORITY_COLORS = {
  high: 'text-red-500 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
  medium:
    'text-yellow-500 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800',
  low: 'text-blue-500 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
};

const PRIORITY_LABELS = {
  high: 'High Impact',
  medium: 'Medium Impact',
  low: 'Low Impact',
};

// ── Utility ───────────────────────────────────────────────────────────────

const cn = (...classes) => classes.filter(Boolean).join(' ');

const getFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(1))} ${units[i]}`;
};

// ── Sub-Components ────────────────────────────────────────────────────────

const CategoryScoreCard = React.memo(({ name, score, maxScore, details, onClick }) => {
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const color =
    percentage >= 80 ? 'text-green-500' : percentage >= 60 ? 'text-yellow-500' : 'text-red-500';
  const bg =
    percentage >= 80
      ? 'bg-green-50 dark:bg-green-900/20'
      : percentage >= 60
        ? 'bg-yellow-50 dark:bg-yellow-900/20'
        : 'bg-red-50 dark:bg-red-900/20';
  const border =
    percentage >= 80
      ? 'border-green-200 dark:border-green-800'
      : percentage >= 60
        ? 'border-yellow-200 dark:border-yellow-800'
        : 'border-red-200 dark:border-red-800';

  const detailItems = useMemo(() => {
    if (!details) return [];
    return Object.entries(details)
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
        const icon = value === true ? '✅' : value === false ? '❌' : null;
        const displayValue = typeof value === 'string' ? value.replace(/_/g, ' ') : value;
        return { key, label, value: displayValue, icon };
      });
  }, [details]);

  return (
    <div
      onClick={onClick}
      className={cn(
        'p-4 rounded-xl border cursor-pointer transition-all hover:shadow-md',
        bg,
        border
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-sm">{name}</span>
        <span className={cn('text-lg font-bold', color)}>{percentage}%</span>
      </div>
      <Progress
        value={percentage}
        size="sm"
        color={percentage >= 80 ? 'success' : percentage >= 60 ? 'warning' : 'danger'}
      />
      <div className="mt-2 text-xs text-gray-500">
        {score} / {maxScore} points
      </div>
      {detailItems.length > 0 && (
        <div className="mt-2 text-xs space-y-0.5">
          {detailItems.slice(0, 3).map((item) => (
            <div
              key={item.key}
              className="flex items-center gap-1 text-gray-600 dark:text-gray-400"
            >
              {item.icon && <span>{item.icon}</span>}
              <span>
                {item.label}:{' '}
                {typeof item.value === 'string' ? item.value.replace(/_/g, ' ') : item.value}
              </span>
            </div>
          ))}
          {detailItems.length > 3 && (
            <span className="text-gray-400">+{detailItems.length - 3} more</span>
          )}
        </div>
      )}
    </div>
  );
});

CategoryScoreCard.displayName = 'CategoryScoreCard';

// ── Main Component ─────────────────────────────────────────────────────────

const ATSScanner = ({ onDataExtracted, onError }) => {
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanResult, setScanResult] = useState(null);
  const [extractedData, setExtractedData] = useState(null);
  const [currentFile, setCurrentFile] = useState(null);
  const [showDetailedReport, setShowDetailedReport] = useState(false);
  const [error, setError] = useState(null);
  const [selectedIndustry, setSelectedIndustry] = useState('technology');
  const [jobRole, setJobRole] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // ── Validate File ─────────────────────────────────────────────────────

  const validateFile = useCallback((file) => {
    const errors = [];
    const ext = file.name.split('.').pop()?.toLowerCase();
    const isValidType =
      Object.keys(ACCEPTED_TYPES).includes(file.type) || ['pdf', 'docx', 'txt'].includes(ext);
    if (!isValidType) errors.push('Unsupported format. Upload PDF, DOCX, or TXT.');
    if (file.size > MAX_FILE_SIZE) errors.push('File too large (max 10MB).');
    if (file.size === 0) errors.push('File is empty.');
    return errors;
  }, []);

  // ── Scan Resume ───────────────────────────────────────────────────────

  const scanResume = useCallback(
    async (resumeFile) => {
      const fileErrors = validateFile(resumeFile);
      if (fileErrors.length > 0) {
        setError(fileErrors[0]);
        toast.error(fileErrors[0]);
        return;
      }

      setScanning(true);
      setError(null);
      setCurrentFile(resumeFile);
      setScanProgress(0);
      setIsProcessing(true);

      try {
        // Step 1: Parse
        setScanProgress(10);
        const parsed = await parseResumeFile(resumeFile, (p) => {
          setScanProgress(10 + p * 0.3);
        });
        if (!parsed || Object.keys(parsed).length === 0) {
          throw new Error('Could not extract data from the file.');
        }
        setExtractedData(parsed);
        setScanProgress(40);

        // Step 2: Detect industry
        const industry = detectIndustry(parsed);
        setSelectedIndustry(industry);
        setScanProgress(50);

        // Step 3: Calculate score
        const scoreResult = await calculateDetailedScore(parsed, industry, jobRole);
        setScanProgress(80);

        // Step 4: Get keyword suggestions
        const keywords = suggestKeywords(industry, parsed.skills?.technical || [], jobRole);
        setScanProgress(90);

        // Step 5: Build result
        const result = {
          score: scoreResult.overall,
          categories: scoreResult.categories,
          recommendations: scoreResult.recommendations,
          industry,
          jobRole: jobRole || 'General',
          missingKeywords: keywords.slice(0, 20),
          fileInfo: {
            name: resumeFile.name,
            size: getFileSize(resumeFile.size),
            type: resumeFile.type,
            scannedAt: new Date().toISOString(),
          },
          extractedData: parsed,
          totalScore: scoreResult.totalScore,
          totalMaxScore: scoreResult.totalMaxScore,
        };

        setScanResult(result);
        setScanProgress(100);
        toast.success('Resume analyzed successfully!');
            } catch (err) {
        console.error('Scan error:', err);
        setError(err.message || 'Failed to scan resume. Please try again.');
        toast.error(err.message || 'Scan failed');
        // Pass a string, not the Error object. `onError` is documented to
        // receive a displayable message. Callers pass its argument directly
        // to `toast.error`, which renders its argument as a React child -
        // passing an Error instance produces React error #31
        // ("Objects are not valid as a React child").
        onError?.(err?.message || 'Scan failed');
      } finally {
        setScanning(false);
        setIsProcessing(false);
      }
    },
    [validateFile, jobRole, onError]
  );

  // ── Dropzone ──────────────────────────────────────────────────────────

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: ACCEPTED_TYPES,
    maxSize: MAX_FILE_SIZE,
    maxFiles: 1,
    onDrop: async (accepted, rejected) => {
      if (rejected.length > 0) {
        const err = rejected[0].errors[0];
        if (err.code === 'file-too-large') toast.error('File too large (max 10MB)');
        else if (err.code === 'file-invalid-type') toast.error('Invalid file type');
        else toast.error(err.message);
        return;
      }
      if (accepted.length > 0) {
        await scanResume(accepted[0]);
      }
    },
    disabled: scanning || isProcessing,
  });

  // ── Handlers ──────────────────────────────────────────────────────────

  const handleImport = useCallback(() => {
    if (extractedData && onDataExtracted) {
      onDataExtracted(extractedData);
      toast.success('Data imported to builder!');
    }
  }, [extractedData, onDataExtracted]);

  const handleExport = useCallback(() => {
    if (!scanResult) return;
    const blob = new Blob(
      [
        JSON.stringify(
          { ...scanResult, extractedData, exportDate: new Date().toISOString() },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ats-report-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Report exported!');
  }, [scanResult, extractedData]);

  const handleReset = useCallback(() => {
    setScanResult(null);
    setExtractedData(null);
    setCurrentFile(null);
    setError(null);
    setScanProgress(0);
    setJobRole('');
  }, []);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Upload Area */}
      {!scanResult && !scanning && !isProcessing && (
        <Card className="p-6 sm:p-8">
          <div
            {...getRootProps()}
            className={cn(
              'border-2 border-dashed rounded-xl p-8 sm:p-12 text-center cursor-pointer transition-all',
              isDragActive
                ? 'border-primary-500 bg-primary-50/50 dark:bg-primary-900/20 scale-105'
                : 'border-gray-300 dark:border-gray-700 hover:border-primary-500'
            )}
          >
            <input {...getInputProps()} />
            <FiUpload className="w-14 h-14 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-semibold mb-2 text-gray-900 dark:text-white">
              {isDragActive ? 'Drop your resume' : 'Upload Resume for ATS Analysis'}
            </h3>
            <p className="text-gray-500 mb-4 text-sm">
              Get instant feedback on ATS compatibility with detailed category scores
            </p>
            <Button variant="primary" className="mx-auto">
              Choose File
            </Button>
            <p className="text-xs text-gray-400 mt-4">PDF, DOCX, TXT (Max 10MB)</p>
          </div>

          {/* Optional Job Role Input */}
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-gray-300">
                Industry
              </label>
              <select
                value={selectedIndustry}
                onChange={(e) => setSelectedIndustry(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
              >
                {INDUSTRIES.map((ind) => (
                  <option key={ind} value={ind.toLowerCase()}>
                    {ind}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-gray-300">
                Job Role (Optional)
              </label>
              <input
                type="text"
                placeholder="e.g., Software Engineer"
                value={jobRole}
                onChange={(e) => setJobRole(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
              />
            </div>
          </div>
        </Card>
      )}

      {/* Scanning Progress */}
      <AnimatePresence>
        {scanning && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
          >
            <Card className="p-8 text-center">
              <div className="w-24 h-24 mx-auto mb-6 relative">
                <motion.div
                  className="absolute inset-0 border-4 border-primary-500 rounded-full border-t-transparent"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                />
                <FiFile className="absolute inset-0 m-auto w-8 h-8 text-primary-500" />
              </div>
              <h3 className="text-xl font-semibold mb-2 text-gray-900 dark:text-white">
                Analyzing...
              </h3>
              <p className="text-gray-500 mb-4">{currentFile?.name}</p>
              <Progress
                value={scanProgress}
                size="lg"
                showPercentage
                className="max-w-md mx-auto"
              />
              <p className="text-xs text-gray-400 mt-3">
                {scanProgress < 40
                  ? 'Extracting text...'
                  : scanProgress < 60
                    ? 'Detecting industry...'
                    : scanProgress < 80
                      ? 'Calculating score...'
                      : scanProgress < 95
                        ? 'Generating recommendations...'
                        : 'Finalizing...'}
              </p>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error State */}
      <AnimatePresence>
        {error && !scanning && !scanResult && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Card className="p-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
              <div className="flex items-start gap-3">
                <FiAlertCircle className="w-6 h-6 text-red-500 flex-shrink-0" />
                <div>
                  <h4 className="font-semibold text-red-700 dark:text-red-400 mb-1">Scan Failed</h4>
                  <p className="text-red-600 dark:text-red-300 mb-3">{error}</p>
                  <Button variant="outline" size="sm" onClick={handleReset}>
                    Try Again
                  </Button>
                </div>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results */}
      <AnimatePresence>
        {scanResult && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            {/* Score Card */}
            <Card className="p-6">
              <div className="flex flex-col sm:flex-row justify-between gap-4 mb-6">
                <div>
                  <div className="flex items-center gap-2">
                    <FiFile className="w-5 h-5 text-gray-400" />
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {scanResult.fileInfo.name}
                    </span>
                    <Badge variant="secondary" size="sm">
                      {scanResult.fileInfo.size}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="primary" size="sm">
                      {scanResult.industry}
                    </Badge>
                    {scanResult.jobRole && (
                      <Badge variant="secondary" size="sm">
                        {scanResult.jobRole}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={handleExport} icon={<FiDownload />}>
                    Export
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleReset} icon={<FiRefreshCw />}>
                    New Scan
                  </Button>
                </div>
              </div>

              {/* ATSScoreMeter */}
              <ATSScoreMeter
                score={scanResult.score}
                breakdown={scanResult.categories}
                size="lg"
                showDetailed
                onScoreClick={() => setShowDetailedReport(true)}
              />
            </Card>

            {/* Category Breakdown */}
            <div>
              <h4 className="font-semibold mb-3 text-gray-900 dark:text-white flex items-center gap-2">
                <FiBarChart2 className="w-5 h-5 text-primary-500" />
                Category Breakdown
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {Object.entries(scanResult.categories).map(([key, category]) => {
                  const name = key
                    .replace(/([A-Z])/g, ' $1')
                    .replace(/^./, (str) => str.toUpperCase());
                  return (
                    <CategoryScoreCard
                      key={key}
                      name={name}
                      score={category.score}
                      maxScore={category.maxScore}
                      details={category.details}
                      onClick={() => setShowDetailedReport(true)}
                    />
                  );
                })}
              </div>
            </div>

            {/* Recommendations */}
            <div>
              <h4 className="font-semibold mb-3 text-gray-900 dark:text-white flex items-center gap-2">
                <FiTrendingUp className="w-5 h-5 text-primary-500" />
                Improvement Recommendations
              </h4>
              <div className="space-y-2">
                {scanResult.recommendations.slice(0, 8).map((rec, index) => (
                  <div
                    key={index}
                    className={cn(
                      'p-3 rounded-lg border flex items-start gap-3',
                      PRIORITY_COLORS[rec.priority] || PRIORITY_COLORS.medium
                    )}
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      {rec.priority === 'high' ? (
                        <FiAlertCircle className="w-4 h-4 text-red-500" />
                      ) : rec.priority === 'medium' ? (
                        <FiInfo className="w-4 h-4 text-yellow-500" />
                      ) : (
                        <FiInfo className="w-4 h-4 text-blue-500" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-white">
                          {rec.message}
                        </span>
                        <Badge
                          variant={
                            rec.priority === 'high'
                              ? 'danger'
                              : rec.priority === 'medium'
                                ? 'warning'
                                : 'info'
                          }
                          size="sm"
                        >
                          {PRIORITY_LABELS[rec.priority]}
                        </Badge>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        Category: {rec.category.replace(/^./, (s) => s.toUpperCase())}
                      </div>
                    </div>
                  </div>
                ))}
                {scanResult.recommendations.length === 0 && (
                  <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800 text-center">
                    <FiCheckCircle className="w-6 h-6 text-green-500 mx-auto mb-2" />
                    <p className="text-sm text-green-700 dark:text-green-300">
                      No major issues found. Your resume is well-optimized!
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Missing Keywords */}
            {scanResult.missingKeywords && scanResult.missingKeywords.length > 0 && (
              <div>
                <h4 className="font-semibold mb-3 text-gray-900 dark:text-white flex items-center gap-2">
                  <FiCode className="w-5 h-5 text-primary-500" />
                  Recommended Keywords
                </h4>
                <div className="flex flex-wrap gap-2">
                  {scanResult.missingKeywords.slice(0, 15).map((keyword, i) => (
                    <Badge
                      key={i}
                      variant="primary"
                      size="md"
                      className="cursor-pointer hover:scale-105 transition-all"
                      onClick={() => {
                        navigator.clipboard?.writeText(keyword);
                        toast.success(`"${keyword}" copied!`);
                      }}
                    >
                      {keyword}
                      <FiCopy className="w-3 h-3 inline ml-1" />
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="sticky bottom-4 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm p-4 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 flex flex-wrap gap-3">
              <Button
                onClick={handleImport}
                className="flex-1"
                icon={<FiUpload />}
                disabled={!onDataExtracted}
              >
                Import to Builder
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowDetailedReport(true)}
                icon={<FiAward />}
              >
                View Full Report
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Detailed Report Modal */}
      <Modal
        isOpen={showDetailedReport}
        onClose={() => setShowDetailedReport(false)}
        title="Detailed ATS Report"
        size="lg"
      >
        {scanResult && (
          <div className="space-y-4 max-h-[70vh] overflow-y-auto">
            <div className="prose dark:prose-invert max-w-none">
              <pre className="text-xs bg-gray-50 dark:bg-gray-800 p-4 rounded-lg overflow-auto">
                {JSON.stringify({ ...scanResult, extractedData: undefined }, null, 2)}
              </pre>
            </div>
            <Button onClick={() => setShowDetailedReport(false)} className="w-full">
              Close
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default React.memo(ATSScanner);
