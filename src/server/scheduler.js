/**
 * Scheduler Service
 * Manages scheduled sync jobs using node-cron
 */

const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class SchedulerService extends EventEmitter {
    constructor() {
        super();
        this.jobs = new Map();
        this.configPath = path.join(__dirname, 'scheduler-config.json');
        this.config = this.loadConfig();
    }

    /**
     * Load scheduler configuration from file
     */
    loadConfig() {
        try {
            if (fs.existsSync(this.configPath)) {
                const data = fs.readFileSync(this.configPath, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Error loading scheduler config:', error);
        }

        // Default configuration
        return {};
    }

    /**
     * Save scheduler configuration to file
     */
    saveConfig() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
            return true;
        } catch (error) {
            console.error('Error saving scheduler config:', error);
            return false;
        }
    }

    /**
     * Initialize scheduler with sync executor function
     * @param {Function} syncExecutor - Function to execute sync (receives syncType)
     */
    initialize(syncExecutor) {
        this.syncExecutor = syncExecutor;

        // Start enabled jobs
        Object.keys(this.config).forEach(jobName => {
            if (this.config[jobName].enabled) {
                this.startJob(jobName);
            }
        });

        console.log('Scheduler service initialized');
    }

    /**
     * Start a scheduled job
     * @param {string} jobName - Name of the job to start
     */
    startJob(jobName) {
        const jobConfig = this.config[jobName];

        if (!jobConfig) {
            console.error(`Job ${jobName} not found in config`);
            return false;
        }

        // Stop existing job if running
        this.stopJob(jobName);

        // Validate cron expression
        if (!cron.validate(jobConfig.cronExpression)) {
            console.error(`Invalid cron expression for ${jobName}: ${jobConfig.cronExpression}`);
            return false;
        }

        // Create and start the job
        const job = cron.schedule(jobConfig.cronExpression, () => {
            this.executeJob(jobName);
        }, {
            scheduled: true,
            timezone: 'UTC'
        });

        this.jobs.set(jobName, {
            job,
            startedAt: new Date().toISOString(),
            lastRun: null,
            runCount: 0
        });

        this.emit('jobStarted', { jobName, config: jobConfig });
        console.log(`Scheduled job ${jobName} started with cron: ${jobConfig.cronExpression}`);

        return true;
    }

    /**
     * Stop a scheduled job
     * @param {string} jobName - Name of the job to stop
     */
    stopJob(jobName) {
        const jobInfo = this.jobs.get(jobName);

        if (jobInfo) {
            jobInfo.job.stop();
            this.jobs.delete(jobName);
            this.emit('jobStopped', { jobName });
            console.log(`Scheduled job ${jobName} stopped`);
            return true;
        }

        return false;
    }

    /**
     * Execute a job manually or via schedule
     * @param {string} jobName - Name of the job to execute
     */
    executeJob(jobName) {
        const jobConfig = this.config[jobName];
        const jobInfo = this.jobs.get(jobName);

        if (!jobConfig || !this.syncExecutor) {
            return;
        }

        const now = new Date().toISOString();

        if (jobInfo) {
            jobInfo.lastRun = now;
            jobInfo.runCount++;
        }

        this.emit('jobExecuting', {
            jobName,
            syncType: jobConfig.syncType,
            timestamp: now
        });

        console.log(`Executing scheduled job: ${jobName} (${jobConfig.syncType})`);

        try {
            this.syncExecutor(jobConfig.syncType);
        } catch (error) {
            console.error(`Error executing scheduled job ${jobName}:`, error);
            this.emit('jobError', { jobName, error: error.message });
        }
    }

    /**
     * Enable or disable a job
     * @param {string} jobName - Name of the job
     * @param {boolean} enabled - Whether to enable or disable
     */
    setJobEnabled(jobName, enabled) {
        if (!this.config[jobName]) {
            return false;
        }

        this.config[jobName].enabled = enabled;
        this.saveConfig();

        if (enabled) {
            this.startJob(jobName);
        } else {
            this.stopJob(jobName);
        }

        return true;
    }

    /**
     * Update job schedule
     * @param {string} jobName - Name of the job
     * @param {string} cronExpression - New cron expression
     */
    updateJobSchedule(jobName, cronExpression) {
        if (!this.config[jobName]) {
            return false;
        }

        if (!cron.validate(cronExpression)) {
            return false;
        }

        this.config[jobName].cronExpression = cronExpression;
        this.saveConfig();

        // Restart job if currently running
        if (this.jobs.has(jobName)) {
            this.startJob(jobName);
        }

        return true;
    }

    /**
     * Get status of all jobs
     */
    getStatus() {
        const status = {};

        Object.keys(this.config).forEach(jobName => {
            const jobConfig = this.config[jobName];
            const jobInfo = this.jobs.get(jobName);

            status[jobName] = {
                ...jobConfig,
                running: this.jobs.has(jobName),
                startedAt: jobInfo?.startedAt || null,
                lastRun: jobInfo?.lastRun || null,
                runCount: jobInfo?.runCount || 0,
                nextRun: this.getNextRunTime(jobName)
            };
        });

        return status;
    }

    /**
     * Get next run time for a job
     * @param {string} jobName - Name of the job
     */
    getNextRunTime(jobName) {
        const jobConfig = this.config[jobName];
        if (!jobConfig || !jobConfig.enabled) {
            return null;
        }

        try {
            const interval = cron.schedule(jobConfig.cronExpression, () => {}, { scheduled: false });
            // node-cron doesn't expose next run time directly, so we estimate
            return 'Scheduled';
        } catch {
            return null;
        }
    }

    /**
     * Get configuration for a specific job
     * @param {string} jobName - Name of the job
     */
    getJobConfig(jobName) {
        return this.config[jobName] || null;
    }

    /**
     * Stop all jobs
     */
    stopAll() {
        this.jobs.forEach((jobInfo, jobName) => {
            this.stopJob(jobName);
        });
    }
}

// Export singleton instance
module.exports = new SchedulerService();
