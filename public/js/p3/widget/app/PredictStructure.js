define([
  'dojo/_base/declare', 'dojo/topic',
  'dijit/_TemplatedMixin', 'dijit/_WidgetsInTemplateMixin',
  'dojo/text!./templates/PredictStructure.html', './AppBase',
  '../../WorkspaceManager'
], function (
  declare, Topic,
  Templated, WidgetsInTemplate,
  Template, AppBase, WorkspaceManager
) {
  return declare([AppBase], {
    baseClass: 'PredictStructure',
    templateString: Template,
    applicationName: 'PredictStructure',
    requireAuth: true,
    applicationLabel: 'Protein Structure Prediction',
    applicationDescription: 'Predict protein structures using Boltz-2, OpenFold 3, Chai-1, AlphaFold 2, or ESMFold. Provides a unified interface with automatic parameter mapping, format conversion, output normalization, and confidence scoring.',
    applicationHelp: 'quick_references/services/predict_structure_service.html',
    tutorialLink: 'tutorial/predict_structure/predict_structure.html',
    videoLink: '',
    pageTitle: 'Protein Structure Prediction Service | BV-BRC',
    required: true,
    defaultPath: '',

    startup: function () {
      var _self = this;
      if (this._started) { return; }
      this.inherited(arguments);
      if (this.requireAuth && (window.App.authorizationToken === null || window.App.authorizationToken === undefined)) {
        return;
      }
      _self.defaultPath = WorkspaceManager.getDefaultFolder() || _self.activeWorkspacePath;
      _self.output_path.set('value', _self.defaultPath);
      this.form_flag = false;
      try {
        this.intakeRerunForm();
      } catch (error) {
        console.error(error);
      }
    },

    postCreate: function () {
      this.inherited(arguments);
      this.onInputChange();
      this.onToolChange();
    },

    openJobsList: function () {
      Topic.publish('/navigate', { href: '/job/' });
    },

    onInputChange: function () {
      // Sequence input radios
      if (typeof this.input_source_text != 'undefined') {
        if (this.input_source_text.checked) {
          dojo.style(this.block_input_file, 'display', 'none');
          dojo.style(this.block_text_input, 'display', 'block');
        } else {
          dojo.style(this.block_input_file, 'display', 'block');
          dojo.style(this.block_text_input, 'display', 'none');
        }
      }
      // MSA mode
      if (typeof this.msa_mode != 'undefined') {
        var mode = this.msa_mode.get('value');
        var currentTool = this.tool ? this.tool.get('value') : '';
        dojo.style(this.block_msa_upload, 'display', mode === 'upload' ? 'block' : 'none');
        // MSA Server URL only applies when Boltz/Chai use the ColabFold server.
        var serverFieldVisible = (mode === 'server' && (currentTool === 'boltz' || currentTool === 'chai'));
        dojo.style(this.block_msa_server_url, 'display', serverFieldVisible ? 'inline-block' : 'none');
      }
      this.checkParameterRequiredFields();
    },

    onToolChange: function () {
      if (typeof this.tool == 'undefined') { return; }
      var tool = this.tool.get('value');
      var blocks = {
        boltz: this.block_boltz,
        chai: this.block_chai,
        esmfold: this.block_esmfold,
        alphafold: this.block_alphafold,
        openfold: this.block_openfold
      };
      Object.keys(blocks).forEach(function (key) {
        dojo.style(blocks[key], 'display', key === tool ? 'block' : 'none');
      });
      // ESMFold does not use MSAs at all — hide the whole MSA section.
      var msaSupported = (tool !== 'esmfold');
      if (this.block_msa) {
        dojo.style(this.block_msa, 'display', msaSupported ? 'block' : 'none');
      }
      // "server" MSA mode is only supported by Boltz and Chai. Rebuild the
      // option list so the server entry appears/disappears and stays in the
      // right display order. Fall back to "none" if it was selected.
      var serverAllowed = (tool === 'boltz' || tool === 'chai');
      if (this.msa_mode) {
        if (!msaSupported) {
          if (this.msa_mode.get('value') !== 'none') {
            this.msa_mode.set('value', 'none');
          }
        } else {
          var current = this.msa_mode.get('value');
          if (!serverAllowed && current === 'server') { current = 'none'; }
          var options = [{ value: 'none', label: 'None' }];
          if (serverAllowed) { options.push({ value: 'server', label: 'ColabFold Server' }); }
          options.push({ value: 'upload', label: 'Upload Pre-computed' });
          this.msa_mode.removeOption(this.msa_mode.getOptions().map(function (o) { return o.value; }));
          this.msa_mode.addOption(options);
          this.msa_mode.set('value', current);
        }
      }
      this.onInputChange();
    },

    getValues: function () {
      var values = this.inherited(arguments);
      var submit = {
        tool: values.tool,
        num_recycles: parseInt(values.num_recycles, 10),
        seed: parseInt(values.seed, 10),
        output_format: values.output_format,
        output_path: values.output_path,
        output_file: values.output_file
      };
      if (values.tool !== 'esmfold') {
        submit.msa_mode = values.msa_mode;
      }

      // Sequence input: workspace file OR text input (one or the other).
      // Backend expects the FASTA text as a single string with embedded "\n"
      // separators, not a JSON array.
      if (values.input_source === 'text') {
        var rawText = values.text_input || '';
        submit.text_input = rawText
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map(function (l) { return l.trim(); })
          .filter(function (l) { return l.length > 0; })
          .join('\n');
      } else {
        if (values.input_file) {
          submit.input_file = values.input_file;
        }
      }

      // MSA extras (ESMFold does not use MSAs)
      if (values.tool !== 'esmfold') {
        if (values.msa_mode === 'upload' && values.msa_file) {
          submit.msa_file = values.msa_file;
        }
        // msa_server_url only applies to Boltz/Chai with server mode
        if (values.msa_server_url && values.msa_mode === 'server'
            && (values.tool === 'boltz' || values.tool === 'chai')) {
          submit.msa_server_url = values.msa_server_url;
        }
      }

      // Engine-specific parameters — only include the block relevant to the tool
      switch (values.tool) {
        case 'boltz':
          submit.num_samples = parseInt(values.num_samples_boltz, 10);
          submit.sampling_steps = parseInt(values.sampling_steps_boltz, 10);
          submit.use_potentials = !!values.use_potentials;
          break;
        case 'chai':
          submit.num_samples = parseInt(values.num_samples_chai, 10);
          submit.sampling_steps = parseInt(values.sampling_steps_chai, 10);
          break;
        case 'esmfold':
          submit.fp16 = !!values.fp16;
          if (values.chunk_size !== '' && values.chunk_size !== undefined && values.chunk_size !== null) {
            submit.chunk_size = parseInt(values.chunk_size, 10);
          }
          if (values.max_tokens_per_batch !== '' && values.max_tokens_per_batch !== undefined && values.max_tokens_per_batch !== null) {
            submit.max_tokens_per_batch = parseInt(values.max_tokens_per_batch, 10);
          }
          break;
        case 'alphafold':
          submit.af2_model_preset = values.af2_model_preset;
          submit.af2_db_preset = values.af2_db_preset;
          submit.af2_max_template_date = values.af2_max_template_date;
          submit.af2_data_dir = values.af2_data_dir;
          break;
        case 'openfold':
          submit.num_diffusion_samples = parseInt(values.num_diffusion_samples, 10);
          submit.num_model_seeds = parseInt(values.num_model_seeds, 10);
          submit.use_templates = !!values.use_templates;
          break;
        // 'auto' uses defaults — send nothing extra
      }

      return submit;
    },

    validFasta: 0,
    minResidues: 10,

    checkFasta: function () {
      // Validate the pasted FASTA text using the shared AppBase helper
      // (seqType 'aa' — this is a protein-structure prediction service).
      // Pass replace=false so missing '>' headers are reported as an error
      // instead of silently auto-prepended.
      var fastaText = this.text_input ? this.text_input.get('value') : '';
      if (!fastaText || !fastaText.trim()) {
        this.validFasta = 0;
        if (this.sequence_message) { this.sequence_message.textContent = ''; }
        this.checkParameterRequiredFields();
        return false;
      }
      var fastaObject = this.validateFasta(fastaText, 'aa', false);
      var message = fastaObject.message || '';
      var valid = !!fastaObject.valid;
      // Enforce a minimum per-record residue count — a handful of letters is
      // never a meaningful input for structure prediction, and the shared
      // validator accepts any length.
      if (valid) {
        var shortRecord = this._findShortRecord(fastaObject.trimFasta, this.minResidues);
        if (shortRecord) {
          valid = false;
          message = 'Sequence "' + shortRecord.id + '" is too short ('
            + shortRecord.length + ' residues); provide at least '
            + this.minResidues + '.';
        }
      }
      if (this.sequence_message) {
        this.sequence_message.textContent = message;
      }
      this.validFasta = valid ? fastaObject.numseq : 0;
      this.checkParameterRequiredFields();
      return valid;
    },

    _findShortRecord: function (fasta, minLen) {
      var lines = (fasta || '').split('\n');
      var currentId = null;
      var currentLen = 0;
      for (var i = 0; i <= lines.length; i++) {
        var line = i < lines.length ? lines[i] : null;
        if (line === null || (line.length > 0 && line[0] === '>')) {
          if (currentId !== null && currentLen < minLen) {
            return { id: currentId, length: currentLen };
          }
          if (line !== null) {
            currentId = line.slice(1).split(/\s+/)[0] || 'record';
            currentLen = 0;
          }
        } else if (line.length > 0) {
          currentLen += line.replace(/-/g, '').length;
        }
      }
      return null;
    },

    _hasSequenceInput: function () {
      if (this.input_source_text && this.input_source_text.checked) {
        var text = this.text_input ? this.text_input.get('value') : '';
        if (!text || !String(text).trim()) { return false; }
        return this.validFasta > 0;
      }
      return !!(this.input_file && this.input_file.get('value'));
    },

    validate: function () {
      var valid = this.inherited(arguments);
      // The radio-selected sequence input source is required; neither widget
      // is marked required in the template because only one applies at a time.
      if (!this._hasSequenceInput()) {
        if (this.submitButton) { this.submitButton.set('disabled', true); }
        return false;
      }
      return valid;
    },

    checkParameterRequiredFields: function () {
      if (
        this._hasSequenceInput() &&
        this.output_path.get('value') &&
        this.output_file.get('displayedValue')
      ) {
        this.validate();
      } else {
        if (this.submitButton) {
          this.submitButton.set('disabled', true);
        }
      }
    },

    onOutputPathChange: function (val) {
      this.inherited(arguments);
      this.checkParameterRequiredFields();
    },

    checkOutputName: function (val) {
      this.inherited(arguments);
      this.checkParameterRequiredFields();
    },

    addRerunFields: function (job_params) {
      if (job_params.tool) { this.tool.set('value', job_params.tool); }

      // Sequence input — text_input is a single FASTA string (with "\n"
      // separators); legacy array form is tolerated for backwards-compat.
      var rerunText = job_params.text_input;
      if (Array.isArray(rerunText)) { rerunText = rerunText.join('\n'); }
      if (rerunText && String(rerunText).trim().length > 0) {
        this.input_source_text.set('checked', true);
        this.text_input.set('value', rerunText);
      } else if (job_params.input_file) {
        this.input_source_file.set('checked', true);
        this.input_file.set('value', job_params.input_file);
      }

      // MSA
      if (job_params.msa_mode) { this.msa_mode.set('value', job_params.msa_mode); }
      if (job_params.msa_file) { this.msa_file.set('value', job_params.msa_file); }
      if (job_params.msa_server_url) { this.msa_server_url.set('value', job_params.msa_server_url); }

      // Common params
      if (job_params.num_recycles !== undefined) { this.num_recycles.set('value', job_params.num_recycles); }
      if (job_params.seed !== undefined) { this.seed.set('value', job_params.seed); }
      if (job_params.output_format) { this.output_format.set('value', job_params.output_format); }

      // Engine-specific — set what matches the restored tool
      switch (job_params.tool) {
        case 'boltz':
          if (job_params.num_samples !== undefined) { this.num_samples_boltz.set('value', job_params.num_samples); }
          if (job_params.sampling_steps !== undefined) { this.sampling_steps_boltz.set('value', job_params.sampling_steps); }
          if (job_params.use_potentials !== undefined) { this.use_potentials.set('checked', !!job_params.use_potentials); }
          break;
        case 'chai':
          if (job_params.num_samples !== undefined) { this.num_samples_chai.set('value', job_params.num_samples); }
          if (job_params.sampling_steps !== undefined) { this.sampling_steps_chai.set('value', job_params.sampling_steps); }
          break;
        case 'esmfold':
          if (job_params.fp16 !== undefined) { this.fp16.set('checked', !!job_params.fp16); }
          if (job_params.chunk_size !== undefined) { this.chunk_size.set('value', job_params.chunk_size); }
          if (job_params.max_tokens_per_batch !== undefined) { this.max_tokens_per_batch.set('value', job_params.max_tokens_per_batch); }
          break;
        case 'alphafold':
          if (job_params.af2_model_preset) { this.af2_model_preset.set('value', job_params.af2_model_preset); }
          if (job_params.af2_db_preset) { this.af2_db_preset.set('value', job_params.af2_db_preset); }
          if (job_params.af2_max_template_date) { this.af2_max_template_date.set('value', job_params.af2_max_template_date); }
          if (job_params.af2_data_dir) { this.af2_data_dir.set('value', job_params.af2_data_dir); }
          break;
        case 'openfold':
          if (job_params.num_diffusion_samples !== undefined) { this.num_diffusion_samples.set('value', job_params.num_diffusion_samples); }
          if (job_params.num_model_seeds !== undefined) { this.num_model_seeds.set('value', job_params.num_model_seeds); }
          if (job_params.use_templates !== undefined) { this.use_templates.set('checked', !!job_params.use_templates); }
          break;
      }

      if (job_params.output_path) { this.output_path.set('value', job_params.output_path); }

      this.onInputChange();
      this.onToolChange();
    },

    intakeRerunForm: function () {
      var service_fields = window.location.search.replace('?', '');
      var rerun_fields = service_fields.split('=');
      var rerun_key;
      if (rerun_fields.length > 1) {
        rerun_key = rerun_fields[1];
        var sessionStorage = window.sessionStorage;
        if (sessionStorage.hasOwnProperty(rerun_key)) {
          try {
            var param_dict = { 'output_folder': 'output_path' };
            AppBase.prototype.intakeRerunFormBase.call(this, param_dict);
            this.addRerunFields(JSON.parse(sessionStorage.getItem(rerun_key)));
            this.form_flag = true;
          } catch (error) {
            console.log('Error during intakeRerunForm: ', error);
          } finally {
            sessionStorage.removeItem(rerun_key);
          }
        }
      }
    }
  });
});
