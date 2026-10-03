import React, { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import DashboardLayout from '../components/layouts/DashboardLayout';
import ATSScanner from '../components/resume/ATSScanner';
import Card from '../components/ui/Card';
import {
  FiArrowLeft,
  FiInfo,
  FiCheckCircle,
  FiFileText,
  FiKey,
  FiBarChart2,
  FiTarget,
} from 'react-icons/fi';
import Button from '../components/ui/Button';
import { usePageTitle } from '../hooks/useDocumentTitle';
import Loader from '../components/common/Loader';
import ErrorBoundary from '../components/common/ErrorBoundary';
import toast from 'react-hot-toast';

const ATSScannerPage = () => {
  const navigate = useNavigate();
  const [isProcessing, setIsProcessing] = useState(false);

  // Set page title and meta
  usePageTitle({
    title: 'ATS Resume Scanner',
    description:
      'Upload your resume for instant ATS compatibility analysis. Get a detailed score, keyword suggestions, and actionable improvements.',
  });

  // ── Handlers ─────────────────────────────────────────────────────────

  const handleDataExtracted = useCallback(
    (data) => {
      setIsProcessing(true);

      // Validate extracted data
      if (!data || Object.keys(data).length === 0) {
        toast.error('No data could be extracted from the file. Please try again.');
        setIsProcessing(false);
        return;
      }

      toast.success('Data extracted! Redirecting to resume builder...', {
        icon: <FiCheckCircle className="w-5 h-5 text-green-500" />,
        duration: 2000,
      });

      // Navigate to builder with extracted data
      setTimeout(() => {
        navigate('/builder', {
          state: { extractedData: data },
          replace: true,
        });
      }, 500);
    },
    [navigate]
  );

  // FIXED: Safe back navigation
  const handleGoBack = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate]);

  // Handle scanner errors.
  //
  // `ATSScanner` calls this with a string message, but that contract is not
  // enforced by types. Coerce defensively so a caller that accidentally
  // passes an `Error` instance (or any non-string) does not surface React
  // error #31 ("Objects are not valid as a React child") when
  // `react-hot-toast` tries to render its argument.
  const handleScannerError = useCallback((error) => {
    const message =
      typeof error === 'string'
        ? error
        : error?.message || 'Failed to analyze resume. Please try again.';
    toast.error(message);
    setIsProcessing(false);
  }, []);

  return (
    <DashboardLayout showWelcome={false}>
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div className="flex items-center gap-4">
            <Button variant="ghost" onClick={handleGoBack} icon={<FiArrowLeft />} size="sm">
              Back
            </Button>
            <div>
              <h1 className="text-2xl font-bold gradient-text">ATS Resume Scanner</h1>
              <p className="text-gray-600 dark:text-gray-400 text-sm">
                Upload your resume to get instant ATS compatibility analysis
              </p>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate('/builder')}>
              Create New Resume
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate('/my-resumes')}>
              My Resumes
            </Button>
          </div>
        </motion.div>

        {/* Info Card */}
        <Card className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <div className="flex gap-3">
            <FiInfo className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-medium text-blue-700 dark:text-blue-300 text-sm">How it works</h3>
              <p className="text-sm text-blue-600 dark:text-blue-400 mt-1">
                Our AI-powered scanner analyzes your resume against industry-standard ATS criteria.
                You'll get a detailed score, keyword suggestions, and actionable improvements.
              </p>
            </div>
          </div>
        </Card>

        {/* Processing Overlay */}
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="glass-card p-8 text-center"
          >
            <Loader variant="brand" size="md" />
            <p className="mt-4 text-gray-600 dark:text-gray-400">Processing your resume data...</p>
            <p className="text-xs text-gray-400 mt-1">Redirecting to resume builder</p>
          </motion.div>
        )}

        {/* Scanner Component */}
        {!isProcessing && (
          <ErrorBoundary>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <ATSScanner onDataExtracted={handleDataExtracted} onError={handleScannerError} />
            </motion.div>
          </ErrorBoundary>
        )}

        {/* Tips Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="p-6">
            <h3 className="font-semibold text-lg mb-4">Tips for Better ATS Scores</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
                <h4 className="font-medium text-sm mb-1 flex items-center gap-2">
                  <FiFileText className="w-4 h-4 text-primary-500" aria-hidden="true" />
                  Use Standard Formats
                </h4>
                <p className="text-xs text-gray-500">
                  Stick to standard section headings like "Experience", "Education", and "Skills".
                </p>
              </div>
              <div className="p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
                <h4 className="font-medium text-sm mb-1 flex items-center gap-2">
                  <FiKey className="w-4 h-4 text-primary-500" aria-hidden="true" />
                  Include Keywords
                </h4>
                <p className="text-xs text-gray-500">
                  Match keywords from job descriptions to improve ATS compatibility.
                </p>
              </div>
              <div className="p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
                <h4 className="font-medium text-sm mb-1 flex items-center gap-2">
                  <FiBarChart2 className="w-4 h-4 text-primary-500" aria-hidden="true" />
                  Quantify Achievements
                </h4>
                <p className="text-xs text-gray-500">
                  Use numbers and percentages to demonstrate your impact.
                </p>
              </div>
              <div className="p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg">
                <h4 className="font-medium text-sm mb-1 flex items-center gap-2">
                  <FiTarget className="w-4 h-4 text-primary-500" aria-hidden="true" />
                  Use Action Verbs
                </h4>
                <p className="text-xs text-gray-500">
                  Start bullet points with strong action verbs like "Led", "Developed", "Achieved".
                </p>
              </div>
            </div>
          </Card>
        </motion.div>
      </div>
    </DashboardLayout>
  );
};

export default ATSScannerPage;
