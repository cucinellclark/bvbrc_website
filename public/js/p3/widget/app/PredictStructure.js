define([
  'dojo/_base/declare', 'dojo/topic',
  'dijit/_TemplatedMixin', 'dijit/_WidgetsInTemplateMixin',
  'dojo/text!./templates/PredictStructure.html', './AppBase',
  '../../WorkspaceManager',
  'dijit/form/Button', 'dijit/form/Select', 'dijit/form/SimpleTextarea',
  'p3/widget/WorkspaceFilenameValidationTextBox', 'p3/widget/WorkspaceObjectSelector'
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
    applicationDescription: 'Predict biomolecular structures (proteins, complexes, protein-DNA/RNA, protein-ligand) using Boltz-2, OpenFold 3, Chai-1, AlphaFold 2, or ESMFold. Provides a unified interface with automatic parameter mapping, format conversion, output normalization, and confidence scoring. Advanced knobs (num_samples, num_recycles, seed, output_format, all tool-specific parameters) use sensible defaults from the predict-structure CLI; expose them via the PredictStructureFull spec or direct CLI / CWL invocation.',
    applicationHelp: 'quick_references/services/predict_structure_service.html',
    tutorialLink: 'tutorial/predict_structure/predict_structure.html',
    videoLink: '',
    pageTitle: 'Protein Structure Prediction Service | BV-BRC',
    required: true,
    defaultPath: '',
    validLigands: true,
    validSmiles: true,

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
      this.checkParameterRequiredFields();
    },

    postCreate: function () {
      this.inherited(arguments);
      this.onToolChange();
    },

    openJobsList: function () {
      Topic.publish('/navigate', { href: '/job/' });
    },

    onToolChange: function () {
      if (this.msa_policy_message) {
        var required = this._isMsaRequired();
        this.msa_policy_message.innerHTML = required
          ? 'Required for the selected prediction tool.'
          : 'Optional for Auto, AlphaFold 2, and ESMFold.';
      }
      this.checkParameterRequiredFields();
    },

    getValues: function () {
      var values = this.inherited(arguments);
      var submit = {
        tool: values.tool,
        output_path: values.output_path
      };

      this._copyIfPresent(submit, 'input_file', values.input_file);
      this._copyIfPresent(submit, 'dna_file', values.dna_file);
      this._copyIfPresent(submit, 'rna_file', values.rna_file);
      this._copyIfPresent(submit, 'msa_file', values.msa_file);
      this._copyIfPresent(submit, 'output_file', values.output_file);

      var ligands = this._parseLigands(values.ligand);
      if (ligands.length > 0) {
        submit.ligand = ligands;
      }

      var smiles = this._parseLines(values.smiles);
      if (smiles.length > 0) {
        submit.smiles = smiles;
      }

      return submit;
    },

    _copyIfPresent: function (target, key, value) {
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        target[key] = value;
      }
    },

    _parseLines: function (value) {
      if (!value) { return []; }
      return String(value)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(function (line) { return line.trim(); })
        .filter(function (line) { return line.length > 0; });
    },

    _parseLigands: function (value) {
      return this._parseLines(value).map(function (line) {
        return line.toUpperCase();
      });
    },

    _listToText: function (value, key) {
      if (!value) { return ''; }
      if (!Array.isArray(value)) { return String(value); }
      return value.map(function (item) {
        if (item && typeof item === 'object') {
          return item[key] || '';
        }
        return item;
      }).filter(function (item) {
        return item !== undefined && item !== null && String(item).trim() !== '';
      }).join('\n');
    },

    _hasAnyBiomoleculeInput: function () {
      if (this.input_file && this.input_file.get('value')) { return true; }
      if (this.dna_file && this.dna_file.get('value')) { return true; }
      if (this.rna_file && this.rna_file.get('value')) { return true; }
      return false;
    },

    _isMsaRequired: function () {
      if (!this.tool) { return false; }
      var tool = this.tool.get('value');
      return tool === 'boltz' || tool === 'openfold' || tool === 'chai';
    },

    _hasRequiredMsa: function () {
      return !this._isMsaRequired() || (this.msa_file && this.msa_file.get('value'));
    },

    _isValidSmiles: function (smiles) {
      // Must contain only legal SMILES characters
      if (!/^[A-Za-z0-9@+\-\[\]()\=#:\/\\\.%*]+$/.test(smiles)) {
        return false;
      }

      // Must start with a valid atom: bracket atom [..], or organic-subset atom
      // Organic subset: B, C, N, O, P, S, F, Cl, Br, I (and aromatic b,c,n,o,p,s)
      if (!/^(\[|B(?!r)|C(?!l)|N|O|P|S(?!i)|F|Cl|Br|I|b|c|n|o|p|s)/.test(smiles)) {
        return false;
      }

      // Must contain at least one atom (letter that is a valid element start)
      // Reject strings that are purely digits/symbols with no atom letter
      if (!/[A-Za-z]/.test(smiles)) {
        return false;
      }

      // Check balanced parentheses and brackets
      var parenDepth = 0;
      var bracketDepth = 0;
      var inBracket = false;
      for (var i = 0; i < smiles.length; i++) {
        var c = smiles[i];
        if (c === '[') {
          bracketDepth++;
          inBracket = true;
        } else if (c === ']') {
          bracketDepth--;
          inBracket = false;
          if (bracketDepth < 0) { return false; }
        } else if (!inBracket) {
          if (c === '(') { parenDepth++; }
          else if (c === ')') {
            parenDepth--;
            if (parenDepth < 0) { return false; }
          }
        }
      }
      if (parenDepth !== 0 || bracketDepth !== 0) { return false; }

      // Reject bare backslashes not used as bond stereo (must be followed by a valid char)
      // A lone \ or \\ at end is invalid
      if (/\\$/.test(smiles)) { return false; }

      // Reject strings with no valid organic-subset atom or bracket atom at all.
      // Valid atom pattern: bracket [...] or one of B,C,N,O,P,S,F,Cl,Br,I (case-sensitive for capitals),
      // or aromatic b,c,n,o,p,s
      var atomPattern = /\[|(?:Cl|Br|[BCNOPSFIbcnops])/;
      if (!atomPattern.test(smiles)) { return false; }

      return true;
    },

    checkSmiles: function () {
      var lines = this.smiles ? this._parseLines(this.smiles.get('value')) : [];
      var _self = this;
      var firstInvalid = -1;
      lines.forEach(function (line, idx) {
        if (firstInvalid === -1 && !_self._isValidSmiles(line)) {
          firstInvalid = idx + 1;
        }
      });
      this.validSmiles = firstInvalid === -1;
      if (this.smiles_message) {
        this.smiles_message.textContent = this.validSmiles
          ? ''
          : 'Invalid SMILES string on line ' + firstInvalid + '. Check for unbalanced brackets/parentheses or illegal characters.';
      }
      this.checkParameterRequiredFields();
    },

    checkLigands: function () {
      var ligands = this.ligand ? this._parseLines(this.ligand.get('value')) : [];
      var invalid = ligands.filter(function (line) {
        return !/^[A-Za-z0-9]{1,3}$/.test(line);
      });
      this.validLigands = invalid.length === 0;
      if (this.ligand_message) {
        this.ligand_message.innerHTML = this.validLigands
          ? ''
          : 'CCD codes must be 1-3 alphanumeric characters.';
      }
      this.checkParameterRequiredFields();
    },

    validate: function () {
      var valid = this.inherited(arguments);
      if (!valid || !this._hasAnyBiomoleculeInput() || !this._hasRequiredMsa() || !this.validLigands || !this.validSmiles) {
        if (this.submitButton) { this.submitButton.set('disabled', true); }
        return false;
      }
      return valid;
    },

    checkParameterRequiredFields: function () {
      if (
        this._hasAnyBiomoleculeInput() &&
        this.output_path.get('value') &&
        this._hasRequiredMsa() &&
        this.validLigands &&
        this.validSmiles
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
      if (job_params.input_file) { this.input_file.set('value', job_params.input_file); }
      if (job_params.dna_file) { this.dna_file.set('value', job_params.dna_file); }
      if (job_params.rna_file) { this.rna_file.set('value', job_params.rna_file); }
      if (job_params.msa_file) { this.msa_file.set('value', job_params.msa_file); }
      if (job_params.ligand) { this.ligand.set('value', this._listToText(job_params.ligand, 'ccd_code')); }
      if (job_params.smiles) { this.smiles.set('value', this._listToText(job_params.smiles, 'smiles_str')); }
      if (job_params.output_path) { this.output_path.set('value', job_params.output_path); }
      if (job_params.output_file) { this.output_file.set('value', job_params.output_file); }

      this.checkLigands();
      this.checkSmiles();
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
