define([
  'dojo/_base/declare', 'dijit/layout/BorderContainer', 'dojo/_base/lang',
  'dijit/layout/StackContainer', 'dijit/layout/ContentPane', 'd3.v5/d3',
  '../WorkspaceManager', 'dojo/dom-geometry'
], function (
  declare, BorderContainer, lang,
  StackContainer, ContentPane, d3,
  WorkspaceManager, domGeom
) {
  return declare([BorderContainer], {

    startup: function () {
      if (this._started) { return; }
      this.inherited(arguments);

      this.tabContainer = new StackContainer({ region: 'center', id: this.id + '_TabContainer' });
      this.addChild(this.tabContainer);

      this.setupPlots();
    },

    setupPlots: function () {

      this.plotContainer = new ContentPane({
        'region': 'center'
      });

      /*
      var svg = d3.select(plotContainer.domNode).append('svg');
      svg.append('circle').attr("cx", 50).attr("cy", 50).attr("r", 40).style("fill", "blue");
      */

      this.volcanoPlot();

      this.tabContainer.addChild(this.plotContainer);
    },

    volcanoPlot: function () {
      var dataPath = '/clark.cucinell@patricbrc.org/home/DevTest/RNASeq_Test/.test_amr_workshop_haemophilus_example/727.3012_6hr_inf_vs_control.deseq2.tsv';
      WorkspaceManager.getObject(dataPath, false).then(lang.hitch(this, function (obj) {
        // load data
        var data = d3.tsvParse(obj.data);
        data = data.map(d => {
          var pval = -Math.log10(parseFloat(d.padj + 0.00000001));
          if (pval === -Infinity) { pval = 0 };
          if (pval === Infinity) { pval = 350 };
          return {
            log2FoldChange: parseFloat(d.log2FoldChange),
            logPadj: pval,
            gene: d.Gene_Name
          };
        });
        data = data.filter(d => !isNaN(d.log2FoldChange));
        data = data.filter(d => !isNaN(d.logPadj));

        // get window dimensions for plot
        var box = domGeom.getContentBox(this.plotContainer.domNode);
        const width = box.w;
        const height = box.h;
        const margin = { top: 50, right: 100, bottom: 30, left: 50 };

        // create plot
        const svg = d3.select(this.plotContainer.domNode).append('svg')
          .attr('width', width).attr('height', height)
          .append('g')
          .attr('transform', 'translat(' + margin.left + ',' + margin.top + ')');

        // create axes
        const x = d3.scaleLinear().domain([d3.min(data, d => d.log2FoldChange), d3.max(data, d => d.log2FoldChange)]).range([margin.left, width - margin.right]);
        const y = d3.scaleLinear().domain([0, d3.max(data, d => d.logPadj)]).range([height - margin.bottom, margin.top]);

        // add axes
        svg.append('g').attr('transform', `translate(0,${height - margin.bottom})`).call(d3.axisBottom(x).ticks(5));
        svg.append('g').attr('transform', `translate(${margin.left},0)`).call(d3.axisLeft(y).ticks(5));
        console.log('wdith= ',width);
        // add axis titles
        svg.append('text')
          .attr('x', width / 2)
          .attr('y', height - margin.bottom + 25)
          .style('text-anchor', 'end')
          .style('fill', 'black')
          .style('font-size', '16px')
          .text('Log2FoldChange');
        svg.append('text')
          .attr('transform', 'rotate(-90)')
          .attr('x', 0 - (height / 2) + margin.left)
          .attr('y', 0)
          .attr('dy', '1em')
          .style('text-anchor', 'end')
          .text('-log10(Pvalue)');


        const circles = svg.selectAll('.dot').data(data);
        circles.enter().append('circle')
          .attr('class', 'dot')
          .attr('cx', d => x(d.log2FoldChange))
          .attr('cy', d => y(d.logPadj))
          .attr('r', 3)
          .style('fill', d => (d.logPadj > 1.3 && Math.abs(d.log2FoldChange) > 1) ? 'red' : 'grey');

        // add interactivity
        svg.selectAll('circle').on('click', function (d) {
          console.log('d = ', d);
        });
        svg.selectAll('circle').on('mouseover', function () {
          d3.select(this).style('fill', 'blue');
        });
        svg.selectAll('circle').on('mouseout', function (d) {
          d3.select(this).style('fill', d => (d.logPadj > 1.3 && Math.abs(d.log2FoldChange) > 1) ? 'red' : 'grey');
        });

        const brushEnd = function () {
          if (!d3.event.selection) { return; }
          var brushCoords = d3.event.selection;
          console.log('brushCoords = ', brushCoords);
          svg.select('.brush').remove();
          svg.selectAll('circle')
            .style('fill', d => (d.logPadj > 1.3 && Math.abs(d.log2FoldChange) > 1) ? 'red' : 'grey');
        };
        const brushing = function () {
          var s = d3.event.selection;
          if (s) {
            var x0 = x.invert(s[0][0]),
              x1 = x.invert(s[1][0]),
              y0 = y.invert(s[1][1]),
              y1 = y.invert(s[0][1]);

            svg.selectAll('circle')
              .style('fill', d => (d.logPadj > 1.3 && Math.abs(d.log2FoldChange) > 1) ? 'red' : 'grey');

            svg.selectAll('circle')
              .filter(function (d) {
                return x0 <= d.log2FoldChange && d.log2FoldChange <= x1 && y0 <= d.logPadj && d.logPadj <= y1;
              })
              .style('fill', 'yellow');
          }
        };
        var brush = d3.brush().on('brush', brushing).on('end', brushEnd);
        const enableBrushing = function () {
          svg.append('g').attr('class', 'brush').call(brush);
        };
        document.addEventListener('keydown', function (event) {
          if (event.ctrlKey && event.shiftKey && event.key === 'B') {
            enableBrushing();
          }
        });
      }));
    }
  });
});
