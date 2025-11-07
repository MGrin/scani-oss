import type { ChartConfiguration } from 'chart.js';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

/**
 * Chart Generator Service
 * Generates chart images for Telegram bot responses
 */
export class ChartGenerator {
  // Chart configuration - dimensions for mobile optimization
  private readonly width = 800;
  private readonly height = 600;
  private readonly backgroundColour = 'white';

  /**
   * Generate a donut/pie chart for portfolio distribution
   */
  async generateDonutChart(data: {
    labels: string[];
    values: number[];
    title: string;
    colors?: string[];
  }): Promise<Buffer> {
    // Create a new instance per chart to avoid concurrency issues
    const chartJSNodeCanvas = new ChartJSNodeCanvas({
      width: this.width,
      height: this.height,
      backgroundColour: this.backgroundColour,
    });
    const defaultColors = [
      '#FF6384', // Red
      '#36A2EB', // Blue
      '#FFCE56', // Yellow
      '#4BC0C0', // Teal
      '#9966FF', // Purple
      '#FF9F40', // Orange
      '#C9CBCF', // Grey
      '#8DD17E', // Green
      '#F285B2', // Pink
      '#FFD700', // Gold
    ];

    const configuration: ChartConfiguration = {
      type: 'doughnut',
      data: {
        labels: data.labels,
        datasets: [
          {
            data: data.values,
            backgroundColor: data.colors || defaultColors.slice(0, data.labels.length),
            borderWidth: 2,
            borderColor: '#ffffff',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: data.title,
            font: {
              size: 20,
              weight: 'bold',
            },
            padding: 20,
          },
          legend: {
            position: 'bottom',
            labels: {
              font: {
                size: 12,
              },
              padding: 15,
              boxWidth: 15,
            },
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                const label = context.label || '';
                const value = context.parsed || 0;
                const total = context.dataset.data.reduce(
                  (a, b) => (a as number) + (b as number),
                  0
                ) as number;
                const percentage = ((value / total) * 100).toFixed(1);
                return `${label}: ${percentage}%`;
              },
            },
          },
        },
      },
      plugins: [
        {
          id: 'customCanvasBackgroundColor',
          beforeDraw: (chart) => {
            // @ts-expect-error - Chart.js uses Node canvas, not DOM
            const ctx = chart.canvas.getContext('2d');
            if (ctx) {
              ctx.save();
              ctx.globalCompositeOperation = 'destination-over';
              ctx.fillStyle = 'white';
              ctx.fillRect(0, 0, chart.width, chart.height);
              ctx.restore();
            }
          },
        },
      ],
    };

    return await chartJSNodeCanvas.renderToBuffer(configuration);
  }

  /**
   * Generate a bar chart for comparisons
   */
  async generateBarChart(data: {
    labels: string[];
    values: number[];
    title: string;
    valueLabel?: string;
    color?: string;
  }): Promise<Buffer> {
    // Create a new instance per chart to avoid concurrency issues
    const chartJSNodeCanvas = new ChartJSNodeCanvas({
      width: this.width,
      height: this.height,
      backgroundColour: this.backgroundColour,
    });
    const configuration: ChartConfiguration = {
      type: 'bar',
      data: {
        labels: data.labels,
        datasets: [
          {
            label: data.valueLabel || 'Value',
            data: data.values,
            backgroundColor: data.color || '#36A2EB',
            borderWidth: 1,
            borderColor: '#2E86C1',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: data.labels.length > 5 ? 'y' : 'x', // Horizontal bars for many items
        plugins: {
          title: {
            display: true,
            text: data.title,
            font: {
              size: 20,
              weight: 'bold',
            },
            padding: 20,
          },
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                // Match indexAxis logic: horizontal if many labels, else vertical
                const isHorizontal = (context.chart.data.labels?.length || 0) > 5;
                return `${isHorizontal ? context.parsed.x : context.parsed.y}`;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              font: {
                size: 12,
              },
            },
          },
          x: {
            ticks: {
              font: {
                size: 12,
              },
            },
          },
        },
      },
      plugins: [
        {
          id: 'customCanvasBackgroundColor',
          beforeDraw: (chart) => {
            // @ts-expect-error - Chart.js uses Node canvas, not DOM
            const ctx = chart.canvas.getContext('2d');
            if (ctx) {
              ctx.save();
              ctx.globalCompositeOperation = 'destination-over';
              ctx.fillStyle = 'white';
              ctx.fillRect(0, 0, chart.width, chart.height);
              ctx.restore();
            }
          },
        },
      ],
    };

    return await chartJSNodeCanvas.renderToBuffer(configuration);
  }

  /**
   * Generate a line chart for time series data (portfolio evolution)
   */
  async generateLineChart(data: {
    labels: string[];
    datasets: Array<{
      label: string;
      values: number[];
      color?: string;
    }>;
    title: string;
    yAxisLabel?: string;
  }): Promise<Buffer> {
    // Create a new instance per chart to avoid concurrency issues
    const chartJSNodeCanvas = new ChartJSNodeCanvas({
      width: this.width,
      height: this.height,
      backgroundColour: this.backgroundColour,
    });
    const defaultColors = ['#36A2EB', '#FF6384', '#FFCE56', '#4BC0C0', '#9966FF'];

    const configuration: ChartConfiguration = {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: data.datasets.map((dataset, index) => ({
          label: dataset.label,
          data: dataset.values,
          borderColor: dataset.color || defaultColors[index % defaultColors.length],
          backgroundColor: `${dataset.color || defaultColors[index % defaultColors.length]}33`, // 20% opacity
          borderWidth: 2,
          fill: true,
          tension: 0.4, // Smooth curves
          pointRadius: 4,
          pointHoverRadius: 6,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: data.title,
            font: {
              size: 20,
              weight: 'bold',
            },
            padding: 20,
          },
          legend: {
            position: 'bottom',
            labels: {
              font: {
                size: 12,
              },
              padding: 15,
            },
          },
          tooltip: {
            mode: 'index',
            intersect: false,
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: !!data.yAxisLabel,
              text: data.yAxisLabel || '',
              font: {
                size: 14,
              },
            },
            ticks: {
              font: {
                size: 12,
              },
            },
          },
          x: {
            ticks: {
              font: {
                size: 12,
              },
            },
          },
        },
      },
      plugins: [
        {
          id: 'customCanvasBackgroundColor',
          beforeDraw: (chart) => {
            // @ts-expect-error - Chart.js uses Node canvas, not DOM
            const ctx = chart.canvas.getContext('2d');
            if (ctx) {
              ctx.save();
              ctx.globalCompositeOperation = 'destination-over';
              ctx.fillStyle = 'white';
              ctx.fillRect(0, 0, chart.width, chart.height);
              ctx.restore();
            }
          },
        },
      ],
    };

    return await chartJSNodeCanvas.renderToBuffer(configuration);
  }
}
